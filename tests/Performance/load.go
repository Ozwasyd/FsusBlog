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
	class  route
	path   string
	id     int
	length int
	digest [sha256.Size]byte
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
	if c.conn == nil {
		dialer := &net.Dialer{Deadline: deadline}
		var socket net.Conn
		var err error
		if c.origin.Scheme == "https" {
			socket, err = tls.DialWithDialer(dialer, "tcp", c.origin.Host, c.tlsConfig)
		} else {
			socket, err = dialer.Dial("tcp", c.origin.Host)
		}
		if err != nil {
			return 0, err
		}
		c.conn = socket
		c.reader = bufio.NewReaderSize(socket, 8192)
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		c.close()
		return 0, err
	}
	req, err := http.NewRequest("GET", c.origin.String()+path, nil)
	if err != nil {
		c.close()
		return 0, err
	}
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "FsusBlogV2-public-read-v1")
	if err := req.Write(c.conn); err != nil {
		c.close()
		return 0, err
	}
	response, err := http.ReadResponse(c.reader, req)
	if err != nil {
		c.close()
		return 0, err
	}
	err = inspect(response)
	if err != nil || response.Close {
		c.close()
	}
	response.Body.Close()
	return response.StatusCode, err
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
			status, err := c.request(expected.path, time.Now().Add(requestLimit), func(response *http.Response) error {
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
}

func worker(c *connection, jobs <-chan job, permits <-chan struct{}, output chan<- result, w workload) {
	defer c.close()
	copyBuffer := make([]byte, 32*1024)
	readBuffer := make([]byte, 0, 48*1024)
	for j := range jobs {
		r := result{class: j.class, dispatch: time.Since(j.planned)}
		var err error
		r.status, err = c.request(j.path, j.planned.Add(requestLimit), func(response *http.Response) error {
			r.reason, err = metadata(response, j.class, w.generation, w.wire.Headers["SearchIndexGeneration"])
			if err != nil {
				return err
			}
			source := io.LimitReader(response.Body, int64(j.length)+1)
			if j.sample {
				buf := bytes.NewBuffer(readBuffer[:0])
				r.bytes, err = io.Copy(buf, source)
				if err == nil {
					digest, digestErr := w.checksum(j.class, buf.Bytes())
					if digestErr != nil || digest != j.digest {
						r.reason = "digest"
						return errors.New("response checksum differs")
					}
				}
				r.sampled = true
			} else {
				r.bytes, err = io.CopyBuffer(io.Discard, source, copyBuffer)
			}
			if err != nil {
				return err
			}
			if int(r.bytes) != j.length {
				r.reason = "length"
				return errors.New("response length differs")
			}
			return nil
		})
		if err != nil && r.reason == "" {
			r.reason = "transport"
			var e net.Error
			if errors.As(err, &e) && e.Timeout() {
				r.reason = "timeout"
			}
		}
		r.latency = time.Since(j.planned)
		<-permits
		output <- r
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
	Sent     int            `json:"sent"`
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

func measure(ctx context.Context, origin *url.URL, w workload, rate, seconds int) map[string]*stats {
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
	collector.Go(func() {
		for r := range results {
			totals["all"].add(r)
			totals[names[r.class]].add(r)
		}
	})
	for i := 0; i < maxInFlight; i++ {
		workers.Go(func() { worker(&connection{origin: origin, tlsConfig: w.tlsConfig}, jobs, permits, results, w) })
	}
	started := time.Now().Add(20 * time.Millisecond)
	for i := 0; i < rate*seconds && ctx.Err() == nil; i++ {
		planned := started.Add(time.Second * time.Duration(i) / time.Duration(rate))
		time.Sleep(time.Until(planned))
		j := w.job(i, planned)
		select {
		case permits <- struct{}{}:
			jobs <- j
		default:
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
	return totals
}

func run() int {
	target := flag.String("target", "", "explicit loopback HTTP or TLS origin with port")
	authority := flag.String("ca", "", "optional PEM authority for an isolated TLS run")
	fixture := flag.String("fixture", "", "seed.py manifest")
	wire := flag.String("wire", "src/Contracts/wire.schema.json", "checked-in wire contract")
	rate := flag.Int("rate", 0, "scheduled requests per second (0 performs preflight only)")
	seconds := flag.Int("seconds", 60, "seconds per measured stage")
	coldLog := flag.String("cold-log", "", "existing private Kestrel log from a fresh, owned cold-cache run")
	output := flag.String("out", "", "new JSON evidence path")
	flag.Parse()
	fail := func(err error) int { fmt.Fprintln(os.Stderr, err); return 1 }
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
		return runCold(ctx, origin, w, *coldLog, out)
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
	if code == 0 && *rate > 0 {
		measured := time.Now().UTC()
		totals := measure(ctx, origin, w, *rate, *seconds)
		all := totals["all"]
		report["measurementStartedAt"], report["routes"] = measured, totals
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
