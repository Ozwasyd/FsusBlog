package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestSupplyTimelineSeparatesPhasesAndIncludesLateDrain(t *testing.T) {
	start := time.Now()
	at := func(ms int) time.Time { return start.Add(time.Duration(ms) * time.Millisecond) }
	timeline := supplyTimeline{start, 2, make(map[int]*admissionSecond), make(map[int]*transferSecond)}
	timeline.recordAdmission(at(1010), at(920), true, 254)
	timeline.recordAdmission(at(1015), at(925), false, 256)
	timeline.recordTransfer(result{planned: at(920), completed: at(2120), bodyCompleted: at(2100),
		exchange: exchange{dialStarted: at(1015), dialFinished: at(1040), dialConnected: true, written: at(1090), headers: at(1999)}})
	timeline.recordTransfer(result{planned: at(985), completed: at(1130), reason: "timeout",
		exchange: exchange{dialStarted: at(1050), dialFinished: at(1130)}})
	timeline.recordTransfer(result{reason: "dropped"})
	rows := timeline.rows(100)
	if len(rows) != 3 {
		t.Fatalf("rows = %+v", rows)
	}
	if got := rows[0]; got.Planned != 100 || got.SchedulerAwake != 0 {
		t.Fatalf("planned second: %+v", got)
	}
	if got := rows[1]; got.Planned != 100 || got.SchedulerAwake != 2 || got.Admitted != 1 || got.Dropped != 1 ||
		got.SocketWritten != 1 || got.HeadersRead != 1 || got.Finished != 1 || got.Correct != 0 ||
		got.DialsStarted != 2 || got.DialsConnected != 1 || got.DialsFailed != 1 || got.OutstandingPeak != 256 ||
		got.MaxWakeDelayMS != 90 || got.MaxWriteDelayMS != 170 || got.MaxDialDurationMS != 80 {
		t.Fatalf("actual second: %+v", got)
	}
	if got := rows[2]; got.Planned != 0 || got.SocketWritten != 0 || got.BodiesRead != 1 ||
		got.Finished != 1 || got.Correct != 1 || got.MaxAfterWriteMS != 1010 {
		t.Fatalf("drain second: %+v", got)
	}
}

func TestSocketWriteIsSeparateFromHTTPResponse(t *testing.T) {
	origin, err := url.Parse("http://127.0.0.1:12345")
	if err != nil {
		t.Fatal(err)
	}
	request, err := encodeRequest(origin, "/")
	if err != nil {
		t.Fatal(err)
	}
	for _, response := range []bool{false, true} {
		t.Run(fmt.Sprintf("response=%t", response), func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			go func() {
				defer server.Close()
				if _, err := io.ReadFull(server, make([]byte, len(request))); err == nil && response {
					_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
				}
			}()
			c := connection{origin: origin, conn: client, reader: bufio.NewReader(client)}
			var observed exchange
			status, err := c.requestEncoded(request, time.Now().Add(time.Second), &observed, func(r *http.Response) error {
				_, err := io.Copy(io.Discard, r.Body)
				return err
			})
			if observed.written.IsZero() || !observed.dialStarted.IsZero() {
				t.Fatalf("write on already connected socket not recorded: %+v", observed)
			}
			if response && (err != nil || status != 200 || observed.headers.IsZero()) {
				t.Fatalf("response not recognized: %d, %v, %+v", status, err, observed)
			}
			if !response && (err == nil || status != 0 || !observed.headers.IsZero()) {
				t.Fatalf("EOF misreported as an HTTP response: %d, %v, %+v", status, err, observed)
			}
		})
	}
}

func TestCancelledScheduleDrainsEveryAttempt(t *testing.T) {
	html := []byte("ok")
	_, current, _, _ := runtime.Caller(0)
	wire, err := os.ReadFile(filepath.Join(filepath.Dir(current), "../../src/Contracts/wire.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(wire, &c); err != nil {
		t.Fatal(err)
	}
	h := c.Header
	offset := number(c.Layouts, "ArticleListCursorOffset")
	packet := make([]byte, number(h, "HeaderSize")+offset)
	pos := func(key string) int { return number(h, key) }
	binary.LittleEndian.PutUint32(packet, uint32(number(h, "Magic")))
	packet[pos("VersionOffset")] = byte(number(h, "Version"))
	packet[pos("LengthOffset")] = byte(number(h, "HeaderSize"))
	binary.LittleEndian.PutUint16(packet[pos("TypeOffset"):], uint16(c.FrameTypes["ArticleList"]))
	binary.LittleEndian.PutUint32(packet[pos("PayloadLengthOffset"):], uint32(offset))
	crc := uint16(0xffff)
	for i := 0; i < offset; i++ {
		crc = (crc >> 8) ^ wireTable[byte(crc)]
	}
	binary.LittleEndian.PutUint16(packet[pos("CrcOffset"):], crc)
	const generation = "123"
	const header = "X-Example-Generation"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set(header, generation)
		// A test timing source, isolated from the real benchmark.
		time.Sleep(50 * time.Millisecond)
		if request.URL.Path == "/binary" {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(packet)
		} else {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write(html)
		}
	}))
	defer server.Close()
	origin, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	c.Headers["SearchIndexGeneration"] = header
	w := workload{generation: generation, wire: c}
	for class := route(0); class < routeCount; class++ {
		path := "/"
		body := html
		if class == homeAEDS || class == detailAEDS {
			path = "/binary"
			body = packet
		}
		encoded, err := encodeRequest(origin, path)
		if err != nil || !bytes.HasPrefix(encoded, []byte("GET ")) {
			t.Fatalf("invalid test request: %q %v", encoded, err)
		}
		keys := 1
		if class == detailHTML || class == detailAEDS {
			keys = hotDetails
		}
		w.paths[class] = make([]expectation, keys)
		digest := sha256.Sum256(body)
		if class == homeAEDS {
			digest = sha256.Sum256(body[number(h, "HeaderSize"):])
		}
		for i := range w.paths[class] {
			w.paths[class][i] = expectation{class: class, request: encoded, length: len(body), digest: digest}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Millisecond)
	defer cancel()
	pool := loadConnections(origin, nil)
	defer func() {
		for i := range pool {
			pool[i].close()
		}
	}()
	_, elapsed, counts, rows := measure(ctx, pool, w, 8000, 1)
	all := counts["all"]
	var wake, admitted, dropped, written, headers, bodies, finished, correct int
	for _, row := range rows {
		wake += row.SchedulerAwake
		admitted += row.Admitted
		dropped += row.Dropped
		written += row.SocketWritten
		headers += row.HeadersRead
		bodies += row.BodiesRead
		finished += row.Finished
		correct += row.Correct
	}
	if ctx.Err() == nil || wake == 0 || wake >= 8000 || elapsed >= requestLimit {
		t.Fatalf("expected a partial schedule that drained, elapsed=%v awake=%d", elapsed, wake)
	}
	if wake != admitted+dropped || admitted != finished || admitted != all.Sent || dropped != all.Dropped ||
		written != all.Written || headers != all.Header || bodies != all.Body || correct != all.OK ||
		written == 0 || headers == 0 || bodies == 0 || correct == 0 {
		t.Fatalf("totals disagree: %+v, rows %+v, wake %d", all, rows, wake)
	}
}

func TestWarmupCarriesAnActualConnectionAndDoesNotRetryStaleSocket(t *testing.T) {
	const header = "X-Example-Generation"
	const generation = "123"
	body := []byte("ok")
	var peers []string
	var requests sync.Mutex
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Lock()
		peers = append(peers, r.RemoteAddr)
		requests.Unlock()
		w.Header().Set(header, generation)
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write(body)
	}))
	defer server.Close()
	origin, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	trust := x509.NewCertPool()
	trust.AddCert(server.Certificate())
	pool := []connection{{origin: origin, tlsConfig: &tls.Config{RootCAs: trust, MinVersion: tls.VersionTLS12}}}
	defer pool[0].close()
	request, err := encodeRequest(origin, "/")
	if err != nil {
		t.Fatal(err)
	}
	w := workload{generation: generation, wire: contract{
		Headers: map[string]string{"SearchIndexGeneration": header},
	}}
	w.paths[homeHTML] = []expectation{{class: homeHTML, path: "/", request: request, length: len(body), digest: sha256.Sum256(body)}}
	_, _, warm, _ := measure(context.Background(), pool, w, 1, 1)
	if warm["all"].OK != 1 || pool[0].conn == nil {
		t.Fatalf("warmup: %+v", warm["all"])
	}
	retainWarmSockets(pool)
	_, _, measured, _ := measure(context.Background(), pool, w, 1, 1)
	if got := continuity(pool); got != (connectionReuse{1, 1, 1, 1, 1}) || measured["all"].OK != 1 {
		t.Fatalf("one valid reused exchange expected: %+v", got)
	}
	requests.Lock()
	if len(peers) != 2 || peers[0] != peers[1] {
		t.Errorf("TLS requests did not use the same physical socket: %v", peers)
	}
	requests.Unlock()

	server.CloseClientConnections()
	pool[0].reuse = connectionReuse{}
	retainWarmSockets(pool)
	_, _, stale, _ := measure(context.Background(), pool, w, 1, 1)
	if got := continuity(pool); got != (connectionReuse{1, 1, 0, 1, 0}) || stale["all"].OK != 0 || stale["all"].Sent != 1 {
		t.Fatalf("stale inherited connection must preserve a failed attempt: %+v", got)
	}
	_, _, later, _ := measure(context.Background(), pool, w, 1, 1)
	if later["all"].OK != 1 {
		t.Fatalf("a later request was not allowed a fresh dial: %+v", later["all"])
	}
}
