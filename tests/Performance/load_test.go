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
	"maps"
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

func TestLoadTargetRequiresExplicitPrivateLiteral(t *testing.T) {
	tests := []struct {
		name, target, privateTarget, authority, expected string
	}{
		{name: "loopback IPv4", target: "http://127.0.0.1:8080", expected: "http://127.0.0.1:8080"},
		{name: "loopback IPv6", target: "https://[::1]:443", expected: "https://[::1]:443"},
		{name: "default rejects private", target: "http://192.168.0.2:8080"},
		{name: "default rejects host names", target: "http://localhost:8080"},
		{name: "private IPv4", privateTarget: "http://192.168.0.2:8080", expected: "http://192.168.0.2:8080"},
		{name: "private TLS", privateTarget: "https://10.2.3.4:443", authority: "ca.pem", expected: "https://10.2.3.4:443"},
		{name: "private IPv6", privateTarget: "http://[fd00::2]:8080", expected: "http://[fd00::2]:8080"},
		{name: "private TLS requires CA", privateTarget: "https://10.2.3.4:443"},
		{name: "private rejects loopback", privateTarget: "http://127.0.0.1:8080"},
		{name: "private rejects public", privateTarget: "http://203.0.113.2:8080"},
		{name: "private rejects link-local", privateTarget: "http://169.254.169.254:80"},
		{name: "private rejects CGNAT", privateTarget: "http://100.64.1.1:8080"},
		{name: "private rejects IPv4-mapped address", privateTarget: "http://[::ffff:10.2.3.4]:8080"},
		{name: "private rejects IPv6 zone", privateTarget: "http://[fd00::2%25en0]:8080"},
		{name: "private rejects host names", privateTarget: "http://test.local:8080"},
		{name: "private rejects user info", privateTarget: "http://guest@10.2.3.4:8080"},
		{name: "private rejects path", privateTarget: "http://10.2.3.4:8080/"},
		{name: "private rejects query", privateTarget: "http://10.2.3.4:8080/?stage=test"},
		{name: "private rejects empty query", privateTarget: "http://10.2.3.4:8080?"},
		{name: "private rejects empty fragment", privateTarget: "http://10.2.3.4:8080#"},
		{name: "private rejects omitted port", privateTarget: "http://10.2.3.4"},
		{name: "private rejects zero port", privateTarget: "http://10.2.3.4:0"},
		{name: "private rejects out of range port", privateTarget: "http://10.2.3.4:65536"},
		{name: "private rejects other protocols", privateTarget: "ftp://10.2.3.4:8080"},
		{name: "mutually exclusive", target: "http://127.0.0.1:8080", privateTarget: "http://192.168.0.2:8080"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			origin, err := parseLoadTarget(tc.target, tc.privateTarget, tc.authority)
			if tc.expected == "" {
				if err == nil {
					t.Fatal("unexpected permitted origin:", origin)
				}
			} else if err != nil || origin.String() != tc.expected {
				t.Fatalf("got %s, %v; want %s", origin, err, tc.expected)
			}
		})
	}
}

func TestRequestPathsCannotChangeLoadOrigin(t *testing.T) {
	origin, err := parseLoadTarget("", "http://192.168.0.2:8080", "")
	if err != nil {
		t.Fatal(err)
	}
	req, err := newLoadRequest(context.Background(), http.MethodGet, origin, "/one/two.aeds?generation=3&page=1")
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.Scheme != origin.Scheme || req.Host != origin.Host || req.URL.RequestURI() != "/one/two.aeds?generation=3&page=1" {
		t.Fatalf("unexpected target URI %s and Host %s", req.URL, req.Host)
	}
	for _, path := range []string{"", "@203.0.113.2:8080/get", "//203.0.113.2:8080/get", "https://203.0.113.2:8080/get"} {
		if _, err := newLoadRequest(context.Background(), http.MethodGet, origin, path); err == nil {
			t.Errorf("accepted invalid load path %q", path)
		}
	}
}

func TestCorpusGenerationReplaysBytesAndIndependentCoordinates(t *testing.T) {
	_, current, _, _ := runtime.Caller(0)
	encodedWire, err := os.ReadFile(filepath.Join(filepath.Dir(current), "../../src/Contracts/wire.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var wire contract
	if err := json.Unmarshal(encodedWire, &wire); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2000, 0)
	articles := []article{
		{ID: 1, CreatedAt: now, PublicationID: 11, TagIDs: []int{7}, TagNames: []string{"𠀀"}},
		{ID: 2, CreatedAt: now, PublicationID: 33, CategoryID: 3, CategoryName: "C"},
	}
	for _, scenario := range []struct {
		name        string
		generation  string
		unavailable bool
		mutate      string
		legacy      bool
	}{
		{name: "available", generation: "6218626370617519827"},
		{name: "unavailable", generation: "7188452516169598208", unavailable: true},
		{name: "frozen legacy profile", generation: "7548595041853034171", legacy: true},
		{name: "legacy generation with current profile", generation: "7548595041853034171", mutate: "previous ranking"},
		{name: "before BM25", generation: "6612586008012810405", mutate: "previous ranking"},
		{name: "changed bytes", generation: "6218626370617519827", mutate: "bytes"},
		{name: "different page generation", generation: "6218626370617519827", mutate: "generation"},
		{name: "changed page count", generation: "6218626370617519827", mutate: "pages"},
		{name: "stale at final HEAD", generation: "6218626370617519827", mutate: "head"},
		{name: "unrelated 503", generation: "7188452516169598208", unavailable: true, mutate: "error"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			packets := [][]byte{make([]byte, 104), make([]byte, 104)}
			for i, packet := range packets {
				copy(packet, "FSPK\x04\x00\x00\x00")
				copy(packet[8:], bytes.Repeat([]byte{byte(i + 1)}, 96))
			}
			if scenario.mutate == "bytes" {
				packets[1][103] ^= 1
			}
			var visits []string
			var mutex sync.Mutex
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mutex.Lock()
				visits = append(visits, r.Method+" "+r.URL.RawQuery)
				mutex.Unlock()
				w.Header().Set(wire.Headers["SearchIndexGeneration"], scenario.generation)
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("Content-Type", "application/octet-stream")
				if scenario.unavailable {
					w.WriteHeader(http.StatusServiceUnavailable)
					if r.Method != http.MethodHead {
						message := "The search corpus is unavailable."
						if scenario.mutate == "error" {
							message = "This operation is temporarily unavailable."
						}
						_, _ = w.Write(corpusErrorVector(wire, http.StatusServiceUnavailable, message))
					}
					return
				}
				w.Header().Set(wire.Headers["SearchIndexPages"], "2")
				if r.Method == http.MethodHead {
					if scenario.mutate == "head" {
						w.WriteHeader(http.StatusConflict)
					} else {
						w.WriteHeader(http.StatusNoContent)
					}
					return
				}
				page := r.URL.Query().Get("page")
				if page == "2" {
					if scenario.mutate == "generation" {
						w.Header().Set(wire.Headers["SearchIndexGeneration"], "70")
					}
					if scenario.mutate == "pages" {
						w.Header().Set(wire.Headers["SearchIndexPages"], "3")
					}
					_, _ = w.Write(packets[1])
				} else {
					_, _ = w.Write(packets[0])
				}
			}))
			defer server.Close()
			origin, err := url.Parse(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			work := workload{wire: wire}
			if scenario.legacy {
				work.wire.Limits = maps.Clone(wire.Limits)
				delete(work.wire.Limits, "SearchFas4Profile")
			}
			err = verifyGeneration(context.Background(), origin, &work, articles)
			if scenario.mutate != "" {
				if err == nil || work.generation != "" {
					t.Fatalf("unexpected admission: %+v, %v", work.corpus, err)
				}
				return
			}
			if err != nil || work.generation != scenario.generation {
				t.Fatalf("admission failed: %+v, %s, %v", work.corpus, work.generation, err)
			}
			want := []string{"GET page=1"}
			if !scenario.unavailable {
				want = append(want, "GET page=2&generation="+scenario.generation)
			}
			want = append(want, "HEAD generation="+scenario.generation)
			mutex.Lock()
			defer mutex.Unlock()
			if fmt.Sprint(visits) != fmt.Sprint(want) {
				t.Fatalf("visits=%v, want %v", visits, want)
			}
		})
	}
}

func corpusErrorVector(wire contract, status uint32, message string) []byte {
	header := wire.Header
	offset := number(header, "HeaderSize")
	packet := make([]byte, offset+number(wire.Layouts, "ErrorBytes"))
	binary.LittleEndian.PutUint32(packet, uint32(number(header, "Magic")))
	packet[number(header, "VersionOffset")] = byte(number(header, "Version"))
	packet[number(header, "LengthOffset")] = byte(offset)
	binary.LittleEndian.PutUint16(packet[number(header, "TypeOffset"):], uint16(wire.FrameTypes["ApiError"]))
	binary.LittleEndian.PutUint32(packet[number(header, "PayloadLengthOffset"):], uint32(len(packet)-offset))
	binary.LittleEndian.PutUint32(packet[offset+number(wire.Layouts, "ErrorStatusOffset"):], status)
	copy(packet[offset+number(wire.Layouts, "ErrorMessageOffset"):], message)
	crc := uint16(0xffff)
	for _, value := range packet[offset:] {
		crc = (crc >> 8) ^ wireTable[byte(crc)^value]
	}
	binary.LittleEndian.PutUint16(packet[number(header, "CrcOffset"):], crc)
	return packet
}

func TestSlowRequestRecordsOrderedBoundariesAndCap(t *testing.T) {
	begin := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(ms int) time.Time { return begin.Add(time.Duration(ms) * time.Millisecond) }
	slow := slowRequests{ThresholdMS: millis(slowRequestThreshold)}
	slow.record(result{class: detailAEDS, reason: "dropped", latency: time.Second})
	slow.record(result{class: detailAEDS, latency: 19 * time.Millisecond})
	slow.record(result{class: detailAEDS, planned: begin, dispatch: 5 * time.Millisecond, latency: 60 * time.Millisecond,
		status: 200, bytes: 256, bodyCompleted: at(58), completed: at(60),
		exchange: exchange{written: at(10), headers: at(52)}})
	if len(slow.Requests) != 1 || slow.Omitted != 0 {
		t.Fatalf("expected one slow attempt: %+v", slow)
	}
	got := slow.Requests[0]
	if got.Route != "detail-aeds" || got.Milliseconds != 60 || got.Bytes != 256 || got.Status != 200 ||
		!got.Planned.Equal(begin) || !got.Worker.Equal(at(5)) || !got.Written.Equal(at(10)) ||
		!got.Headers.Equal(at(52)) || !got.Body.Equal(at(58)) || !got.Finished.Equal(at(60)) {
		t.Fatalf("wrong slow attempt phases: %+v", got)
	}
	if got.Phases.PlannedToWorker != 5 || *got.Phases.WorkerToWrite != 5 || *got.Phases.WriteToHeaders != 42 ||
		*got.Phases.HeadersToBody != 6 || *got.Phases.BodyToFinish != 2 {
		t.Fatalf("wrong slow attempt phase durations: %+v", got.Phases)
	}
	for len(slow.Requests) < slowRequestLimit {
		slow.record(result{class: homeHTML, planned: begin, completed: at(25), latency: 25 * time.Millisecond, reason: "timeout"})
	}
	if item := slow.Requests[len(slow.Requests)-1]; item.Written != nil || item.Headers != nil || item.Body != nil || item.Error != "timeout" {
		t.Fatalf("failed write fabricated a timestamp: %+v", item)
	}
	slow.record(result{class: homeHTML, latency: time.Second})
	if slow.Omitted != 1 || len(slow.Requests) != slowRequestLimit {
		t.Fatalf("cap not enforced: kept=%d omitted=%d", len(slow.Requests), slow.Omitted)
	}
}

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
	_, elapsed, counts, rows := measure(ctx, pool, w, 8000, 1, nil)
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
	_, _, warm, _ := measure(context.Background(), pool, w, 1, 1, nil)
	if warm["all"].OK != 1 || pool[0].conn == nil {
		t.Fatalf("warmup: %+v", warm["all"])
	}
	retainWarmSockets(pool)
	_, _, measured, _ := measure(context.Background(), pool, w, 1, 1, nil)
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
	_, _, stale, _ := measure(context.Background(), pool, w, 1, 1, nil)
	if got := continuity(pool); got != (connectionReuse{1, 1, 0, 1, 0}) || stale["all"].OK != 0 || stale["all"].Sent != 1 {
		t.Fatalf("stale inherited connection must preserve a failed attempt: %+v", got)
	}
	_, _, later, _ := measure(context.Background(), pool, w, 1, 1, nil)
	if later["all"].OK != 1 {
		t.Fatalf("a later request was not allowed a fresh dial: %+v", later["all"])
	}
}
