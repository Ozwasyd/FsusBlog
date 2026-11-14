// Command load drives the fixed public-read workload against a loopback v2 server.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"runtime/metrics"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
)

const (
	hotDetails   = 1200
	maxInFlight  = 256
	requestLimit = 2 * time.Second
	maxBody      = 2 << 20
	workloadSeed = uint64(20261114)
)

type route int

const (
	homeHTML route = iota
	detailHTML
	homeAEDS
	detailAEDS
	routeCount
)

var names = [routeCount]string{"home-html", "detail-html", "home-aeds", "detail-aeds"}

type article struct {
	ID            int       `json:"id"`
	Title         string    `json:"title"`
	BodyBytes     int       `json:"bodyBytes"`
	BodySHA256    string    `json:"bodySha256"`
	HTMLBodyBytes int       `json:"htmlBodyBytes"`
	HTMLBodySHA   string    `json:"htmlBodySha256"`
	State         string    `json:"state"`
	CreatedAt     time.Time `json:"createdAt"`
	PublishedAt   time.Time `json:"publishedAt"`
	PublicationID int64     `json:"publicationId"`
	CategoryID    int       `json:"categoryId"`
	CategoryName  string    `json:"categoryName"`
	TagIDs        []int     `json:"tagIds"`
	TagNames      []string  `json:"tagNames"`
}

type contract struct {
	Header     map[string]json.RawMessage
	FrameTypes map[string]int
	Routes     map[string]string
	Headers    map[string]string
	Layouts    map[string]json.RawMessage
}

func number(values map[string]json.RawMessage, name string) int {
	var i int
	if err := json.Unmarshal(values[name], &i); err != nil {
		var literal string
		if err := json.Unmarshal(values[name], &literal); err == nil {
			i, err = strconv.Atoi(literal)
			if err != nil {
				value, parse := strconv.ParseInt(literal, 0, 32)
				if parse != nil {
					panic("invalid protocol field: " + name)
				}
				i = int(value)
			}
		} else {
			panic("missing protocol field: " + name)
		}
	}
	return i
}

type expectation struct {
	class   route
	path    string
	id      int
	length  int
	digest  [sha256.Size]byte
	request []byte
}

type workload struct {
	paths      [routeCount][]expectation
	articles   []article
	generation string
	wire       contract
	fixture    string
	tlsConfig  *tls.Config
	protocol   string
	tlsVersion string
}

func readWorkload(fixturePath, wirePath string) (workload, error) {
	var w workload
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		return w, err
	}
	var manifest struct{ Articles []article }
	if err := json.Unmarshal(fixture, &manifest); err != nil || len(manifest.Articles) != 12100 {
		return w, errors.New("fixture must contain exactly 12100 article entries")
	}
	counts := map[int]int{}
	publications := make(map[int64]bool)
	for index, entry := range manifest.Articles {
		id := index + 1
		state := "public"
		if id > 12050 {
			state = "withdrawal"
		} else if id > 12000 {
			state = "draft"
		}
		digest, digestErr := hex.DecodeString(entry.BodySHA256)
		if entry.ID != id || entry.Title == "" || digestErr != nil || len(digest) != sha256.Size || entry.State != state || entry.CreatedAt.IsZero() {
			return w, fmt.Errorf("invalid fixture entry %d", id)
		}
		if entry.State == "draft" {
			if entry.PublicationID != 0 || !entry.PublishedAt.IsZero() {
				return w, fmt.Errorf("draft fixture %d has a public coordinate", id)
			}
			continue
		}
		if entry.PublicationID <= 0 || publications[entry.PublicationID] || entry.PublishedAt.IsZero() {
			return w, fmt.Errorf("invalid publication fixture %d", id)
		}
		publications[entry.PublicationID] = true
		w.articles = append(w.articles, entry)
		if id <= 12000 {
			counts[entry.BodyBytes]++
		}
	}
	if counts[2048] != 8400 || counts[8192] != 3000 || counts[32768] != 600 {
		return w, errors.New("fixture body sizes do not match frozen workload")
	}
	byTime := append([]article(nil), w.articles...)
	sort.Slice(byTime, func(i, j int) bool {
		if byTime[i].PublishedAt.Equal(byTime[j].PublishedAt) {
			return byTime[i].ID > byTime[j].ID
		}
		return byTime[i].PublishedAt.After(byTime[j].PublishedAt)
	})
	var coordinate [20]byte
	h := sha256.New()
	for _, entry := range byTime {
		binary.LittleEndian.PutUint32(coordinate[:], uint32(entry.ID))
		binary.LittleEndian.PutUint64(coordinate[4:], 1)
		binary.LittleEndian.PutUint64(coordinate[12:], uint64(entry.PublicationID))
		h.Write(coordinate[:])
		if entry.CategoryID > 0 {
			fmt.Fprintf(h, "C%d:%d:%s", entry.CategoryID, len(utf16.Encode([]rune(entry.CategoryName))), entry.CategoryName)
		}
		if len(entry.TagIDs) != len(entry.TagNames) {
			return w, fmt.Errorf("invalid tag fixture %d", entry.ID)
		}
		for i, id := range entry.TagIDs {
			fmt.Fprintf(h, "T%d:%d:%s", id, len(utf16.Encode([]rune(entry.TagNames[i]))), entry.TagNames[i])
		}
	}
	w.generation = strconv.FormatUint(binary.LittleEndian.Uint64(h.Sum(nil))&0x7fffffffffffffff, 10)
	w.fixture = fmt.Sprintf("%x", sha256.Sum256(fixture))
	encodedWire, err := os.ReadFile(wirePath)
	if err != nil {
		return w, err
	}
	if err := json.Unmarshal(encodedWire, &w.wire); err != nil {
		return w, err
	}
	if w.wire.Routes["PublicList"] == "" || w.wire.Routes["PublicArticle"] == "" || w.wire.Headers["SearchIndexGeneration"] == "" {
		return w, errors.New("public routes or generation header missing from wire schema")
	}
	listPath := strings.NewReplacer("{page:int}", "1", "{size:int}", "20").Replace(w.wire.Routes["PublicList"])
	w.paths[homeHTML] = []expectation{{class: homeHTML, path: "/"}}
	w.paths[homeAEDS] = []expectation{{class: homeAEDS, path: listPath}}
	for id := 1; id <= hotDetails; id++ {
		p := strings.Replace(w.wire.Routes["PublicArticle"], "{id}", strconv.Itoa(id), 1)
		w.paths[detailHTML] = append(w.paths[detailHTML], expectation{class: detailHTML, path: "/article/" + strconv.Itoa(id), id: id})
		w.paths[detailAEDS] = append(w.paths[detailAEDS], expectation{class: detailAEDS, path: p, id: id})
	}
	// The list and home encode their newest articles in the same publication order.
	w.articles = append(w.articles, byTime[:20]...)
	return w, nil
}

// One outstanding request per connection avoids hidden HTTP client retries and pipelining.
// ReadResponse still handles Content-Length and chunked bodies using the standard parser.
type connection struct {
	origin    *url.URL
	tlsConfig *tls.Config
	conn      net.Conn
	reader    *bufio.Reader
}

func (c *connection) close() {
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
}

func (c *connection) request(path string, deadline time.Time, inspect func(*http.Response) error) (int, error) {
	request, err := encodeRequest(c.origin, path)
	if err != nil {
		return 0, err
	}
	return c.requestEncoded(request, deadline, nil, inspect)
}

func encodeRequest(origin *url.URL, path string) ([]byte, error) {
	req, err := http.NewRequest("GET", origin.String()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "FsusBlogV2-public-read-v1")
	var wire bytes.Buffer
	if err = req.Write(&wire); err != nil {
		return nil, err
	}
	return wire.Bytes(), nil
}

type exchange struct {
	dialStarted, dialFinished time.Time
	dialConnected             bool
	written, headers          time.Time
}

func (c *connection) requestEncoded(request []byte, deadline time.Time, observed *exchange, inspect func(*http.Response) error) (int, error) {
	dialing := observed != nil && c.conn == nil
	if dialing {
		observed.dialStarted = time.Now()
	}
	err := c.connect(deadline)
	if dialing {
		observed.dialFinished = time.Now()
		observed.dialConnected = err == nil
	}
	if err != nil {
		return 0, err
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		c.close()
		return 0, err
	}
	n, err := c.conn.Write(request)
	if observed != nil && n == len(request) {
		observed.written = time.Now()
	}
	if err != nil || n != len(request) {
		c.close()
		if err == nil {
			err = io.ErrShortWrite
		}
		return 0, err
	}
	response, err := http.ReadResponse(c.reader, nil)
	if err != nil {
		c.close()
		return 0, err
	}
	if observed != nil {
		observed.headers = time.Now()
	}
	err = inspect(response)
	if err != nil || response.Close {
		c.close()
	}
	response.Body.Close()
	return response.StatusCode, err
}

func (c *connection) connect(deadline time.Time) error {
	if c.conn != nil {
		return nil
	}
	dialer := &net.Dialer{Deadline: deadline}
	var socket net.Conn
	var err error
	if c.origin.Scheme == "https" {
		socket, err = tls.DialWithDialer(dialer, "tcp", c.origin.Host, c.tlsConfig)
	} else {
		socket, err = dialer.Dial("tcp", c.origin.Host)
	}
	if err != nil {
		return err
	}
	c.conn = socket
	c.reader = bufio.NewReaderSize(socket, 8192)
	return nil
}

func metadata(response *http.Response, class route, generation, header string) (string, error) {
	content, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	expected := "text/html"
	if class == homeAEDS || class == detailAEDS {
		expected = "application/octet-stream"
	}
	encoding := response.Header.Get("Content-Encoding")
	if response.StatusCode != 200 || err != nil || content != expected || (encoding != "" && encoding != "identity") {
		return "status_or_type", errors.New("status, media type or content encoding differs")
	}
	if values := response.Header.Values(header); len(values) != 1 || values[0] != generation {
		return "generation", errors.New("public generation differs from the fixture")
	}
	return "", nil
}

func preflight(ctx context.Context, origin *url.URL, w *workload) error {
	c := connection{origin: origin, tlsConfig: w.tlsConfig}
	defer c.close()
	header := w.wire.Headers["SearchIndexGeneration"]
	for class := route(0); class < routeCount; class++ {
		for index := range w.paths[class] {
			if err := ctx.Err(); err != nil {
				return err
			}
			expected := &w.paths[class][index]
			request, err := encodeRequest(origin, expected.path)
			if err != nil {
				return err
			}
			expected.request = request
			status, err := c.requestEncoded(request, time.Now().Add(requestLimit), nil, func(response *http.Response) error {
				if response.Proto != "HTTP/1.1" {
					return errors.New("expected HTTP/1.1")
				}
				w.protocol = response.Proto
				if secure, ok := c.conn.(*tls.Conn); ok {
					w.tlsVersion = tls.VersionName(secure.ConnectionState().Version)
				}
				if _, err := metadata(response, class, w.generation, header); err != nil {
					return err
				}
				body, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
				if err != nil || len(body) > maxBody || len(body) == 0 {
					return errors.New("could not read a complete bounded body")
				}
				if err = w.validate(class, expected.id, body); err != nil {
					return err
				}
				expected.length = len(body)
				expected.digest, err = w.checksum(class, body)
				return err
			})
			if err != nil {
				return fmt.Errorf("GET %s (%d): %w", expected.path, status, err)
			}
		}
	}
	return nil
}

var wireTable = func() [256]uint16 {
	var table [256]uint16
	for i := range table {
		value := uint16(i)
		for bit := 0; bit < 8; bit++ {
			if value&1 == 1 {
				value = (value >> 1) ^ 0xa001
			} else {
				value >>= 1
			}
		}
		table[i] = value
	}
	return table
}()

func u32(data []byte, off int) int   { return int(binary.LittleEndian.Uint32(data[off:])) }
func u64(data []byte, off int) int64 { return int64(binary.LittleEndian.Uint64(data[off:])) }

func (w workload) parseFrame(body []byte, name string) ([]byte, error) {
	v := w.wire.Header
	size := number(v, "HeaderSize")
	if len(body) < size || u32(body, 0) != number(v, "Magic") || int(body[number(v, "VersionOffset")]) != number(v, "Version") || int(body[number(v, "LengthOffset")]) != size ||
		binary.LittleEndian.Uint16(body[number(v, "FlagsOffset"):]) != 0 || int(binary.LittleEndian.Uint16(body[number(v, "TypeOffset"):])) != w.wire.FrameTypes[name] || u32(body, number(v, "PayloadLengthOffset")) != len(body)-size {
		return nil, errors.New("AEDS envelope does not match the expected frame")
	}
	payload := body[size:]
	crc := uint16(0xffff)
	for _, value := range payload {
		crc = (crc >> 8) ^ wireTable[byte(crc)^value]
	}
	if crc != binary.LittleEndian.Uint16(body[number(v, "CrcOffset"):]) {
		return nil, errors.New("AEDS CRC differs")
	}
	return payload, nil
}

func textSlot(record []byte, slot int, blob []byte) []byte {
	offset, length := u32(record, slot), u32(record, slot+4)
	if offset > len(blob) || length > len(blob)-offset {
		return nil
	}
	return blob[offset : offset+length]
}

func (w workload) checksum(class route, body []byte) ([sha256.Size]byte, error) {
	if class == homeAEDS {
		frame, err := w.parseFrame(body, "ArticleList")
		if err != nil {
			return [sha256.Size]byte{}, err
		}
		// Next-cursor expiry/signature changes over time. Validate the frame CRC,
		// then hash the stable payload with only the cursor characters zeroed.
		cursor := number(w.wire.Layouts, "ArticleListCursorOffset")
		length := number(w.wire.Layouts, "ArticleListCursorLengthOffset")
		if len(frame) < cursor || u32(frame, length) > len(frame)-cursor {
			return [sha256.Size]byte{}, errors.New("invalid cursor bounds")
		}
		for i := cursor; i < cursor+u32(frame, length); i++ {
			value := frame[i]
			if !(value >= '0' && value <= '9' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' || value == '-' || value == '_') {
				return [sha256.Size]byte{}, errors.New("invalid cursor alphabet")
			}
			frame[i] = 0
		}
		body = frame
	}
	return sha256.Sum256(body), nil
}

func (w workload) validate(class route, id int, body []byte) error {
	newest := w.articles[len(w.articles)-20:]
	if class == homeHTML {
		from := 0
		for _, a := range newest[:10] {
			marker := fmt.Sprintf(`<a href="/article/%d">%s</a>`, a.ID, a.Title)
			where := bytes.Index(body[from:], []byte(marker))
			if where < 0 {
				return fmt.Errorf("home lacks article %d in publication order", a.ID)
			}
			from += where + len(marker)
		}
		return nil
	}
	if class == detailHTML {
		a := w.articles[id-1]
		if !bytes.Contains(body, []byte("<h1>"+a.Title+"</h1>")) {
			return errors.New("HTML detail has a different title")
		}
		_, after, found := strings.Cut(string(body), "</h1><p>")
		markup, _, closed := strings.Cut(after, "</p>")
		text := []byte(html.UnescapeString(markup))
		if !found || !closed || len(text) != a.HTMLBodyBytes || fmt.Sprintf("%x", sha256.Sum256(text)) != a.HTMLBodySHA {
			return errors.New("HTML detail body differs from the seeded article")
		}
		return nil
	}
	layout := func(name string) int { return number(w.wire.Layouts, name) }
	if class == detailAEDS {
		a := w.articles[id-1]
		frame, err := w.parseFrame(body, "ArticleDetail")
		if err != nil {
			return err
		}
		if len(frame) < 44 || u32(frame, 0) != layout("ArticleDetailV5Magic") || u32(frame, 4) != layout("ArticleDetailV5Version") {
			return errors.New("unexpected AEDS article detail layout")
		}
		start, lenRecord, blobOffset := u32(frame, 12), u32(frame, 16), u32(frame, 36)
		if start != layout("ArticleDetailHeaderSize") || lenRecord != layout("ArticleDetailV5RecordSize") || blobOffset < start+lenRecord || blobOffset > len(frame) {
			return errors.New("invalid AEDS detail offsets")
		}
		record, blob := frame[start:start+lenRecord], frame[blobOffset:]
		off := layout("ArticleDetailCoordinatesOffset")
		text := textSlot(record, layout("ArticleDetailBodyOffset"), blob)
		if u32(record, 0) != id || u64(record, off) != 1 || u64(record, off+12) != a.PublicationID ||
			string(textSlot(record, layout("ArticleDetailTitleOffset"), blob)) != a.Title || len(text) != a.BodyBytes || fmt.Sprintf("%x", sha256.Sum256(text)) != a.BodySHA256 ||
			u32(record, layout("ArticleCategoryIdOffset")) != a.CategoryID || string(textSlot(record, layout("ArticleDetailCategoryOffset"), blob)) != a.CategoryName ||
			!matchesTags(frame, blob, u32(frame, 20), u32(frame, 24), layout("ArticleTagRecordSize"), a) {
			return errors.New("AEDS detail identity, projection coordinate or content differs")
		}
		return nil
	}
	frame, err := w.parseFrame(body, "ArticleList")
	if err != nil {
		return err
	}
	if len(frame) < 29 || u32(frame, 0) != layout("ArticleListCursorMagic") || u32(frame, 4) != layout("ArticleListCursorVersion") ||
		u32(frame, layout("ArticleListTotalOffset")) != len(w.articles)-20 {
		return errors.New("unexpected AEDS list layout or total")
	}
	meta := layout("ArticleListCursorOffset") + u32(frame, layout("ArticleListCursorLengthOffset"))
	if meta > len(frame)-12 || u32(frame, meta) != len(newest) {
		return errors.New("AEDS list count or cursor differs")
	}
	blobStart := meta + 12
	blobEnd := blobStart + u32(frame, meta+8)
	size := layout("ArticleListRecordSizeCurrent")
	tagSize := layout("ArticleTagRecordSize")
	tagOffset := blobEnd + size*len(newest)
	if tagOffset+tagSize*u32(frame, meta+4) != len(frame) {
		return errors.New("AEDS list has invalid boundaries")
	}
	for i, a := range newest {
		record := frame[blobEnd+i*size : blobEnd+(i+1)*size]
		off := layout("ArticleListCoordinatesOffset")
		blob := frame[blobStart:blobEnd]
		firstTag := tagOffset + tagSize*u32(record, layout("ArticleListTagStartOffset"))
		if u32(record, 0) != a.ID || u64(record, off) != 1 || u64(record, off+12) != a.PublicationID ||
			string(textSlot(record, layout("ArticleListTitleOffset"), blob)) != a.Title ||
			u32(record, layout("ArticleCategoryIdOffset")) != a.CategoryID || string(textSlot(record, layout("ArticleListCategoryOffset"), blob)) != a.CategoryName ||
			!matchesTags(frame, blob, firstTag, u32(record, layout("ArticleListTagCountOffset")), tagSize, a) {
			return fmt.Errorf("AEDS list row %d identity, coordinates or title differ", i)
		}
	}
	return nil
}

func matchesTags(frame, blob []byte, start, count, size int, a article) bool {
	if start > len(frame) || count != len(a.TagIDs) || start+size*count > len(frame) {
		return false
	}
	for i, id := range a.TagIDs {
		at := start + size*i
		if u32(frame, at) != id || string(textSlot(frame[at:at+size], 4, blob)) != a.TagNames[i] {
			return false
		}
	}
	return true
}

// SplitMix64 produces the same schedule for every run of the workload.
func (w workload) job(seq int, planned time.Time) job {
	roll := seq % 100
	class := homeHTML
	switch {
	case roll >= 70:
		class = detailAEDS
	case roll >= 50:
		class = homeAEDS
	case roll >= 20:
		class = detailHTML
	}
	index := 0
	if class == detailHTML || class == detailAEDS {
		x := workloadSeed + uint64(seq)*0x9e3779b97f4a7c15
		x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
		x = (x ^ (x >> 27)) * 0x94d049bb133111eb
		x ^= x >> 31
		if x%10 < 8 {
			index = int((x / 10) % 120)
		} else {
			index = 120 + int((x/10)%(hotDetails-120))
		}
	}
	sample := seq%1000 == [...]int{0, 21, 53, 73}[class]
	return job{planned, w.paths[class][index], sample}
}

type job struct {
	planned time.Time
	expectation
	sample bool
}

type result struct {
	class    route
	status   int
	reason   string
	latency  time.Duration
	dispatch time.Duration
	bytes    int64
	sampled  bool
	exchange
	bodyCompleted time.Time
	completed     time.Time
	planned       time.Time
}

func worker(c *connection, jobs <-chan job, permits <-chan struct{}, output chan<- result, w workload) {
	defer c.close()
	copyBuffer := make([]byte, 32*1024)
	readBuffer := make([]byte, 0, 48*1024)
	for j := range jobs {
		r := result{class: j.class, dispatch: time.Since(j.planned), planned: j.planned}
		status, err := c.requestEncoded(j.request, j.planned.Add(requestLimit), &r.exchange, func(response *http.Response) error {
			reason, metadataErr := metadata(response, j.class, w.generation, w.wire.Headers["SearchIndexGeneration"])
			if metadataErr != nil {
				r.reason = reason
				return metadataErr
			}
			source := io.LimitReader(response.Body, int64(j.length)+1)
			var received int64
			var readErr error
			if j.sample {
				buf := bytes.NewBuffer(readBuffer[:0])
				received, readErr = io.Copy(buf, source)
				if readErr == nil && received <= int64(j.length) {
					r.bodyCompleted = time.Now()
				}
				if readErr == nil {
					digest, digestErr := w.checksum(j.class, buf.Bytes())
					if digestErr != nil || digest != j.digest {
						r.reason = "digest"
						return errors.New("response checksum differs")
					}
				}
				r.sampled = true
			} else {
				received, readErr = io.CopyBuffer(io.Discard, source, copyBuffer)
				if readErr == nil && received <= int64(j.length) {
					r.bodyCompleted = time.Now()
				}
			}
			if readErr != nil {
				return readErr
			}
			r.bytes = received
			if int(received) != j.length {
				r.reason = "length"
				return errors.New("response length differs")
			}
			return nil
		})
		r.status = status
		if err != nil && r.reason == "" {
			r.reason = readFailure(err)
		}
		r.completed = time.Now()
		r.latency = r.completed.Sub(j.planned)
		<-permits
		output <- r
	}
}

func readFailure(err error) string {
	var network net.Error
	switch {
	case errors.As(err, &network) && network.Timeout():
		return "timeout"
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return "transport_eof"
	case errors.Is(err, syscall.ECONNRESET):
		return "transport_reset"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "transport_refused"
	case errors.Is(err, syscall.EPIPE):
		return "transport_broken_pipe"
	case errors.Is(err, io.ErrShortWrite):
		return "transport_short_write"
	default:
		return "transport"
	}
}

// Microsecond bins for fast responses, millisecond bins above 100 ms.
const histogramCutoff = 100000

type histogram [histogramCutoff + 2001]uint32

func (h *histogram) add(value time.Duration) {
	us := min(value.Microseconds(), int64(2000000))
	if us > histogramCutoff {
		us = histogramCutoff + (us-histogramCutoff+999)/1000
	}
	h[us]++
}

func (h *histogram) percentile(n, percent int) float64 {
	if n == 0 {
		return 0
	}
	count := 0
	for i, frequency := range h {
		count += int(frequency)
		if count >= (n*percent+99)/100 {
			if i > histogramCutoff {
				return float64(i - histogramCutoff + 100)
			}
			return float64(i) / 1000
		}
	}
	panic("inconsistent latency histogram")
}

type stats struct {
	Sent     int            `json:"sent"` // Legacy field: attempts, including failures before any socket write.
	Written  int            `json:"socketWritten"`
	Header   int            `json:"responseHeadersRead"`
	Body     int            `json:"responseBodiesRead"`
	Dropped  int            `json:"dropped"`
	OK       int            `json:"ok"`
	Bytes    int64          `json:"bytes"`
	Sampled  int            `json:"sampled"`
	Status   map[int]int    `json:"httpStatus"`
	Errors   map[string]int `json:"errors"`
	P50MS    float64        `json:"p50Ms"`
	P95MS    float64        `json:"p95Ms"`
	P99MS    float64        `json:"p99Ms"`
	Dispatch float64        `json:"dispatchP99Ms"`
	latency  histogram
	dispatch histogram
}

func (s *stats) add(r result) {
	if r.reason == "dropped" {
		s.Dropped++
		return
	}
	s.Sent++
	if !r.written.IsZero() {
		s.Written++
	}
	if r.status != 0 {
		s.Header++
	}
	if !r.bodyCompleted.IsZero() {
		s.Body++
	}
	s.Status[r.status]++
	s.dispatch.add(r.dispatch)
	if r.reason != "" {
		s.Errors[r.reason]++
		return
	}
	s.OK++
	s.Bytes += r.bytes
	if r.sampled {
		s.Sampled++
	}
	s.latency.add(r.latency)
}

func loadConnections(origin *url.URL, config *tls.Config) []connection {
	pool := make([]connection, maxInFlight)
	for i := range pool {
		pool[i] = connection{origin: origin, tlsConfig: config}
	}
	return pool
}

func warmTLSConnections(ctx context.Context, pool []connection) error {
	for i := range pool {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := pool[i].connect(time.Now().Add(requestLimit)); err != nil {
			return fmt.Errorf("TLS connection %d: %w", i+1, err)
		}
	}
	return nil
}

type admissionSecond struct {
	dequeued int
	admitted int
	dropped  int
	high     int
	wakeMax  time.Duration
}

type transferSecond struct {
	written, headers, body, finished, correct int
	dialStarted, dialConnected, dialFailed    int
	writeDelay, afterWrite, dialMax           time.Duration
}

type supplySecond struct {
	Second            int     `json:"second"`
	Planned           int     `json:"planned"`
	SchedulerAwake    int     `json:"schedulerAwake"`
	Admitted          int     `json:"admitted"`
	Dropped           int     `json:"dropped"`
	SocketWritten     int     `json:"socketWritten"`
	HeadersRead       int     `json:"responseHeadersRead"`
	BodiesRead        int     `json:"responseBodiesRead"`
	Finished          int     `json:"attemptFinished"`
	Correct           int     `json:"correct"`
	DialsStarted      int     `json:"dialsStarted"`
	DialsConnected    int     `json:"dialsConnected"`
	DialsFailed       int     `json:"dialsFailed"`
	OutstandingPeak   int     `json:"observedOutstandingPeak"`
	MaxWakeDelayMS    float64 `json:"maxWakeDelayMs"`
	MaxWriteDelayMS   float64 `json:"maxWriteDelayMs"`
	MaxAfterWriteMS   float64 `json:"maxAfterWriteMs"`
	MaxDialDurationMS float64 `json:"maxDialDurationMs"`
}

type supplyTimeline struct {
	epoch      time.Time
	seconds    int
	admissions map[int]*admissionSecond // Producer owns this map.
	transfers  map[int]*transferSecond  // Collector owns this map.
}

func (s supplyTimeline) recordAdmission(at, planned time.Time, admitted bool, observedOutstanding int) {
	second := int(at.Sub(s.epoch) / time.Second)
	slot := s.admissions[second]
	if slot == nil {
		slot = &admissionSecond{}
		s.admissions[second] = slot
	}
	slot.dequeued++
	slot.wakeMax = max(slot.wakeMax, at.Sub(planned))
	if admitted {
		slot.admitted++
		slot.high = max(slot.high, observedOutstanding)
	} else {
		slot.dropped++
		slot.high = maxInFlight
	}
}

func (s supplyTimeline) transfer(at time.Time) *transferSecond {
	second := int(at.Sub(s.epoch) / time.Second)
	slot := s.transfers[second]
	if slot == nil {
		slot = &transferSecond{}
		s.transfers[second] = slot
	}
	return slot
}

func (s supplyTimeline) recordTransfer(r result) {
	if r.reason == "dropped" {
		return
	}
	if !r.dialStarted.IsZero() {
		s.transfer(r.dialStarted).dialStarted++
		finished := s.transfer(r.dialFinished)
		if r.dialConnected {
			finished.dialConnected++
		} else {
			finished.dialFailed++
		}
		finished.dialMax = max(finished.dialMax, r.dialFinished.Sub(r.dialStarted))
	}
	done := s.transfer(r.completed)
	done.finished++
	if !r.bodyCompleted.IsZero() {
		s.transfer(r.bodyCompleted).body++
	}
	if !r.headers.IsZero() {
		s.transfer(r.headers).headers++
	}
	if r.reason == "" {
		done.correct++
	}
	if !r.written.IsZero() {
		written := s.transfer(r.written)
		written.written++
		written.writeDelay = max(written.writeDelay, r.written.Sub(r.planned))
		if !r.bodyCompleted.IsZero() {
			body := s.transfer(r.bodyCompleted)
			body.afterWrite = max(body.afterWrite, r.bodyCompleted.Sub(r.written))
		}
	}
}

func (s supplyTimeline) rows(rate int) []supplySecond {
	last := s.seconds - 1
	for second := range s.admissions {
		last = max(last, second)
	}
	for second := range s.transfers {
		last = max(last, second)
	}
	rows := make([]supplySecond, last+1)
	for second := range rows {
		row := &rows[second]
		row.Second = second
		if second < s.seconds {
			row.Planned = rate
		}
		if slot := s.admissions[second]; slot != nil {
			row.SchedulerAwake = slot.dequeued
			row.Admitted, row.Dropped, row.OutstandingPeak = slot.admitted, slot.dropped, slot.high
			row.MaxWakeDelayMS = millis(slot.wakeMax)
		}
		if slot := s.transfers[second]; slot != nil {
			row.SocketWritten, row.HeadersRead, row.BodiesRead = slot.written, slot.headers, slot.body
			row.Finished, row.Correct = slot.finished, slot.correct
			row.DialsStarted, row.DialsConnected, row.DialsFailed = slot.dialStarted, slot.dialConnected, slot.dialFailed
			row.MaxWriteDelayMS, row.MaxAfterWriteMS, row.MaxDialDurationMS =
				millis(slot.writeDelay), millis(slot.afterWrite), millis(slot.dialMax)
		}
	}
	return rows
}

type producerSample struct {
	UserCPUSeconds      float64 `json:"userCpuSeconds"`
	KernelCPUSeconds    float64 `json:"kernelCpuSeconds"`
	CumulativeGCSeconds float64 `json:"gcPauseCpuSeconds"`
	GCCount             uint64  `json:"gcCollections"`
	RuntimeMaxProcs     int     `json:"runtimeMaxProcs"`
	SchedulerProcs      int     `json:"cpuAvailableToProducer"`
	AllocatedBytes      uint64  `json:"allocatedBytes"`
}

func sampleProducer() (producerSample, error) {
	var usage syscall.Rusage
	err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	if err != nil {
		return producerSample{}, err
	}
	runtimeSamples := []metrics.Sample{{Name: "/cpu/classes/gc/pause:cpu-seconds"},
		{Name: "/gc/cycles/total:gc-cycles"}, {Name: "/gc/heap/allocs:bytes"}}
	metrics.Read(runtimeSamples)
	if runtimeSamples[0].Value.Kind() != metrics.KindFloat64 ||
		runtimeSamples[1].Value.Kind() != metrics.KindUint64 ||
		runtimeSamples[2].Value.Kind() != metrics.KindUint64 {
		return producerSample{}, errors.New("Required Go GC/cpu/heap metrics are unavailable")
	}
	return producerSample{
		UserCPUSeconds:      float64(usage.Utime.Nano()) / 1e9,
		KernelCPUSeconds:    float64(usage.Stime.Nano()) / 1e9,
		CumulativeGCSeconds: runtimeSamples[0].Value.Float64(),
		GCCount:             runtimeSamples[1].Value.Uint64(),
		RuntimeMaxProcs:     runtime.GOMAXPROCS(0),
		SchedulerProcs:      runtime.NumCPU(),
		AllocatedBytes:      runtimeSamples[2].Value.Uint64(),
	}, nil
}

func measure(ctx context.Context, pool []connection, w workload, rate, seconds int) (time.Time, time.Duration, map[string]*stats, []supplySecond) {
	// Admission counts queued jobs and active requests against the same limit.
	// A worker briefly between reads must not turn unused capacity into an offered drop.
	jobs := make(chan job, maxInFlight)
	permits := make(chan struct{}, maxInFlight)
	results := make(chan result, maxInFlight)
	var workers sync.WaitGroup
	var collector sync.WaitGroup
	totals := map[string]*stats{}
	for _, name := range append(names[:], "all") {
		totals[name] = &stats{Status: map[int]int{}, Errors: map[string]int{}}
	}
	timeline := supplyTimeline{seconds: seconds, admissions: make(map[int]*admissionSecond), transfers: make(map[int]*transferSecond)}
	collector.Go(func() {
		for r := range results {
			totals["all"].add(r)
			totals[names[r.class]].add(r)
			timeline.recordTransfer(r)
		}
	})
	for i := range pool {
		workers.Go(func() { worker(&pool[i], jobs, permits, results, w) })
	}
	started := time.Now().Add(20 * time.Millisecond)
	timeline.epoch = started
	for i := 0; i < rate*seconds && ctx.Err() == nil; i++ {
		planned := started.Add(time.Second * time.Duration(i) / time.Duration(rate))
		time.Sleep(time.Until(planned))
		awake := time.Now()
		j := w.job(i, planned)
		select {
		case permits <- struct{}{}:
			timeline.recordAdmission(awake, planned, true, len(permits))
			jobs <- j
		default:
			timeline.recordAdmission(awake, planned, false, maxInFlight)
			results <- result{class: j.class, reason: "dropped"}
		}
	}
	close(jobs)
	workers.Wait()
	close(results)
	collector.Wait()
	for _, s := range totals {
		s.P50MS = s.latency.percentile(s.OK, 50)
		s.P95MS = s.latency.percentile(s.OK, 95)
		s.P99MS = s.latency.percentile(s.OK, 99)
		s.Dispatch = s.dispatch.percentile(s.Sent, 99)
	}
	return started.UTC(), time.Since(started), totals, timeline.rows(rate)
}

func startRuntimeMeasurement(ctx context.Context, directory string) error {
	command := directory + "/runtime.mark"
	temporary := command + ".new"
	if err := os.WriteFile(temporary, []byte("measure-before\n"), 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, command); err != nil {
		return err
	}
	acknowledgment := directory + "/measure-before.ack"
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if _, err := os.Stat(acknowledgment); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
	return errors.New("runtime evidence did not mark the start of load measurement")
}

func run() int {
	target := flag.String("target", "", "explicit loopback HTTP or TLS origin with port")
	authority := flag.String("ca", "", "optional PEM authority for an isolated TLS run")
	fixture := flag.String("fixture", "", "seed.py manifest")
	wire := flag.String("wire", "src/Contracts/wire.schema.json", "checked-in wire contract")
	rate := flag.Int("rate", 0, "scheduled requests per second (0 performs preflight only)")
	seconds := flag.Int("seconds", 60, "seconds per measured stage")
	coldLog := flag.String("cold-log", "", "existing private Kestrel log from a fresh, owned cold-cache run")
	coldPressure := flag.Bool("cold-pressure", false, "after standard cold rounds run overload and actual disconnect diagnostics")
	runtimeControl := flag.String("runtime-control", "", "private run directory for a runtime measurement boundary")
	preconnect := flag.Bool("preconnect-tls", false, "establish the 256 TLS connections serially before load")
	output := flag.String("out", "", "new JSON evidence path")
	flag.Parse()
	fail := func(err error) int { fmt.Fprintln(os.Stderr, err); return 1 }
	if *coldPressure && *coldLog == "" {
		return fail(errors.New("cold pressure requires the private cold-cache log"))
	}
	origin, err := url.Parse(*target)
	if err != nil || origin.Host == "" || origin.Port() == "" || origin.User != nil || origin.Path != "" ||
		origin.RawQuery != "" || origin.Fragment != "" || !net.ParseIP(origin.Hostname()).IsLoopback() ||
		(origin.Scheme != "http" && origin.Scheme != "https") || *fixture == "" || *output == "" || *rate < 0 || *rate > 11000 || *seconds < 1 || *seconds > 900 {
		return fail(errors.New("explicit loopback target, fixture and output required; rate 0..11000, seconds 1..900"))
	}
	w, err := readWorkload(*fixture, *wire)
	if err != nil {
		return fail(err)
	}
	if origin.Scheme == "https" {
		w.tlsConfig, err = loadTLSConfig(*authority)
		if err != nil {
			return fail(err)
		}
	} else if *authority != "" {
		return fail(errors.New("a certificate authority requires an HTTPS target"))
	}
	if *preconnect && (origin.Scheme != "https" || *rate == 0) {
		return fail(errors.New("TLS preconnection requires an HTTPS target and hot load"))
	}
	out, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fail(err)
	}
	defer out.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *coldLog != "" {
		if origin.Scheme != "http" || *rate != 0 {
			return fail(errors.New("cold sampling requires a fresh direct origin and no hot load"))
		}
		return runCold(ctx, origin, w, *coldLog, *coldPressure, out)
	}
	started := time.Now().UTC()
	err = preflight(ctx, origin, &w)
	report := map[string]any{
		"startedAt": started, "target": origin.String(), "generation": w.generation, "fixtureSha256": w.fixture,
		"requestedRate": *rate, "seconds": *seconds, "preflight": "pass", "protocol": w.protocol, "tlsVersion": w.tlsVersion,
	}
	code := 0
	if err != nil {
		report["preflight"], report["error"] = "fail", err.Error()
		code = 1
	} else {
		report["responses"] = 2 + 2*hotDetails
		type payload struct {
			Route  string `json:"route"`
			Bytes  int    `json:"bytes"`
			SHA256 string `json:"sha256"`
		}
		checkedPayloads := map[string]payload{}
		for _, group := range w.paths {
			for _, expected := range group {
				checkedPayloads[expected.path] = payload{names[expected.class], expected.length, hex.EncodeToString(expected.digest[:])}
			}
		}
		report["preflightPayloads"] = checkedPayloads
	}
	pool := loadConnections(origin, w.tlsConfig)
	defer func() {
		for i := range pool {
			pool[i].close()
		}
	}()
	if code == 0 && *preconnect {
		warmed := time.Now()
		if err = warmTLSConnections(ctx, pool); err != nil {
			report["measurement"], report["measurementError"] = "preconnect_failed", err.Error()
			code = 1
		} else {
			report["preconnectedTLS"] = len(pool)
			report["preconnectSeconds"] = time.Since(warmed).Seconds()
		}
	}
	if code == 0 && *rate > 0 && *runtimeControl != "" {
		if err = startRuntimeMeasurement(ctx, *runtimeControl); err != nil {
			report["measurement"], report["measurementError"] = "runtime_boundary_failed", err.Error()
			code = 1
		}
	}
	if code == 0 && *rate > 0 {
		producerBefore, beforeErr := sampleProducer()
		measured, elapsed, totals, timeline := measure(ctx, pool, w, *rate, *seconds)
		finished := time.Now().UTC()
		producerAfter, afterErr := sampleProducer()
		all := totals["all"]
		report["measurementStartedAt"], report["measurementCompletedAt"], report["routes"] = measured, finished, totals
		report["measurementElapsedSeconds"] = elapsed.Seconds()
		report["supplyBySecond"] = timeline
		if supplyErr := errors.Join(beforeErr, afterErr); supplyErr != nil {
			report["producerResourceError"] = supplyErr.Error()
		} else {
			report["producerBefore"], report["producerAfter"] = producerBefore, producerAfter
		}
		report["correctPerSecond"] = float64(all.OK) / float64(*seconds)
		report["expected"] = *rate * *seconds
		if ctx.Err() != nil || all.OK != all.Sent || all.Dropped != 0 {
			// Preserve full raw evidence regardless of stage outcome. The runner evaluates the production thresholds.
			report["measurement"] = "errors_or_dropped"
		} else {
			report["measurement"] = "all_correct"
		}
	}
	report["finishedAt"] = time.Now().UTC()
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		return fail(err)
	}
	if ctx.Err() != nil {
		return 130
	}
	if code != 0 {
		return fail(err)
	}
	return 0
}

func loadTLSConfig(authority string) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}}
	if authority == "" {
		return config, nil
	}
	certificates, err := os.ReadFile(authority)
	if err != nil {
		return nil, err
	}
	config.RootCAs = x509.NewCertPool()
	if !config.RootCAs.AppendCertsFromPEM(certificates) {
		return nil, errors.New("no usable certificate in the supplied authority PEM")
	}
	return config, nil
}

func main() { os.Exit(run()) }
