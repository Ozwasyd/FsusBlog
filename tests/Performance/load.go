// Command load drives the fixed public-read workload against an explicitly selected v2 server.
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
	"net/netip"
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
	Limits     map[string]json.RawMessage
}

func number(values map[string]json.RawMessage, name string) int {
	var i int
	if err := json.Unmarshal(values[name], &i); err == nil {
		return i
	}
	var literal string
	if err := json.Unmarshal(values[name], &literal); err != nil {
		panic("missing protocol field: " + name)
	}
	value, err := strconv.ParseInt(literal, 0, 32)
	if err != nil {
		panic("invalid protocol field: " + name)
	}
	return int(value)
}

func (c contract) header(name string) int { return number(c.Header, name) }
func (c contract) layout(name string) int { return number(c.Layouts, name) }
func (c contract) limit(name string) int  { return number(c.Limits, name) }

func sortArticlesDesc(src []article, at func(article) time.Time) []article {
	ordered := append([]article(nil), src...)
	sort.Slice(ordered, func(i, j int) bool {
		ti, tj := at(ordered[i]), at(ordered[j])
		if ti.Equal(tj) {
			return ordered[i].ID > ordered[j].ID
		}
		return ti.After(tj)
	})
	return ordered
}

func checkMediaAndEncoding(response *http.Response, expected string) bool {
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	enc := response.Header.Get("Content-Encoding")
	return err == nil && media == expected && (enc == "" || enc == "identity")
}

func readBoundedBody(r io.Reader, limit int) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(body) > limit {
		return nil, errors.New("response exceeds its byte budget")
	}
	return body, nil
}

func writeIndentedJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readWire(path string) (contract, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return contract{}, err
	}
	var wire contract
	return wire, json.Unmarshal(encoded, &wire)
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
	corpus     corpusPreflight
}

func (w workload) detailExpectation(class route, id int) expectation {
	idText := strconv.Itoa(id)
	path := "/article/" + idText
	if class == detailAEDS {
		path = strings.Replace(w.wire.Routes["PublicArticle"], "{id}", idText, 1)
	}
	return expectation{class: class, path: path, id: id}
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
		if len(entry.TagIDs) != len(entry.TagNames) {
			return w, fmt.Errorf("invalid tag fixture %d", entry.ID)
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
	byTime := sortArticlesDesc(w.articles, func(a article) time.Time { return a.PublishedAt })
	w.fixture = sha256Hex(fixture)
	if w.wire, err = readWire(wirePath); err != nil {
		return w, err
	}
	if w.wire.Routes["PublicList"] == "" || w.wire.Routes["PublicArticle"] == "" || w.wire.Routes["PublicSearchCorpus"] == "" ||
		w.wire.Headers["SearchIndexGeneration"] == "" || w.wire.Headers["SearchIndexPages"] == "" {
		return w, errors.New("public routes or generation header missing from wire schema")
	}
	listPath := strings.NewReplacer("{page:int}", "1", "{size:int}", "20").Replace(w.wire.Routes["PublicList"])
	w.paths[homeHTML] = []expectation{{class: homeHTML, path: "/"}}
	w.paths[homeAEDS] = []expectation{{class: homeAEDS, path: listPath}}
	for id := 1; id <= hotDetails; id++ {
		w.paths[detailHTML] = append(w.paths[detailHTML], w.detailExpectation(detailHTML, id))
		w.paths[detailAEDS] = append(w.paths[detailAEDS], w.detailExpectation(detailAEDS, id))
	}
	// The list and home encode their newest articles in the same publication order.
	w.articles = append(w.articles, byTime[:20]...)
	return w, nil
}

type corpusPreflight struct {
	Status int `json:"status"`
	Pages  int `json:"pages"`
	Bytes  int `json:"bytes"`
}

func verifyGeneration(ctx context.Context, origin *url.URL, w *workload, published []article) error {
	transport := &http.Transport{TLSClientConfig: w.tlsConfig, DisableCompression: true, DisableKeepAlives: true}
	client := &http.Client{Transport: transport, Timeout: requestLimit,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	generationHeader, pagesHeader := w.wire.Headers["SearchIndexGeneration"], w.wire.Headers["SearchIndexPages"]
	pageBytes, totalBytes, maxPages := w.wire.limit("SearchCorpusPageBytes"), w.wire.limit("SearchCorpusTotalBytes"), w.wire.limit("SearchCorpusMaxPages")
	sum := sha256.New()
	_, _ = io.WriteString(sum, "public-generation-corpus-v1\x00")
	searchProfile := 1
	if encodedProfile, present := w.wire.Limits["SearchFas4Profile"]; present {
		if err := json.Unmarshal(encodedProfile, &searchProfile); err != nil || searchProfile != 2 {
			return errors.New("unknown FAS4 search profile")
		}
	}
	_, _ = fmt.Fprintf(sum, "public-search-bm25-v%d\x00", searchProfile)
	appendNumber := func(value int) {
		var buf [4]byte
		binary.LittleEndian.PutUint32(buf[:], uint32(value))
		sum.Write(buf[:])
	}
	var observed string
	var evidence corpusPreflight
	// These requests are outside the timed workload and do not touch the detail cache.
	request := func(method, query string) (*http.Response, error) {
		req, err := newLoadRequest(ctx, method, origin, w.wire.Routes["PublicSearchCorpus"]+query)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/octet-stream")
		req.Header.Set("Accept-Encoding", "identity")
		return client.Do(req)
	}
	fetchPage := func(query string) (*http.Response, []byte, error) {
		response, err := request(http.MethodGet, query)
		if err != nil {
			return nil, nil, err
		}
		defer response.Body.Close()
		if response.Proto != "HTTP/1.1" || response.Header.Get("Cache-Control") != "no-store" || !checkMediaAndEncoding(response, "application/octet-stream") {
			return nil, nil, errors.New("unexpected corpus protocol, cache policy or media type")
		}
		limit := min(pageBytes, totalBytes-evidence.Bytes)
		if response.StatusCode != http.StatusOK {
			limit = 4096
		}
		if response.ContentLength > int64(limit) {
			return nil, nil, errors.New("corpus response exceeds its byte budget")
		}
		body, err := readBoundedBody(response.Body, limit)
		return response, body, err
	}
	for page := 1; ; page++ {
		path := "?page=" + strconv.Itoa(page)
		if page > 1 {
			path += "&generation=" + observed
		}
		response, body, err := fetchPage(path)
		if err != nil {
			return fmt.Errorf("search corpus page %d: %w", page, err)
		}
		values := response.Header.Values(generationHeader)
		if len(values) != 1 || !canonicalGeneration(values[0]) || page > 1 && values[0] != observed {
			return errors.New("corpus generation header differs across pages")
		}
		counts := response.Header.Values(pagesHeader)
		if page == 1 && response.StatusCode == http.StatusServiceUnavailable {
			payload, err := w.parseApiError(body, http.StatusServiceUnavailable)
			if err != nil || len(counts) != 0 {
				return errors.New("invalid unavailable corpus response")
			}
			message := payload[w.wire.layout("ErrorMessageOffset"):w.wire.layout("ErrorDetailsOffset")]
			if string(bytes.TrimRight(message, "\x00")) != "The search corpus is unavailable." {
				return errors.New("corpus returned a different availability failure")
			}
			observed, evidence.Status = values[0], response.StatusCode
			appendNumber(-1)
			break
		}
		if response.StatusCode != http.StatusOK || len(counts) != 1 {
			return errors.New("corpus page status or page count differs")
		}
		count, err := strconv.Atoi(counts[0])
		if err != nil || count < page || count > maxPages || strconv.Itoa(count) != counts[0] || page > 1 && count != evidence.Pages {
			return errors.New("corpus page count outside the expected range")
		}
		if page == 1 {
			observed, evidence.Pages, evidence.Status = values[0], count, response.StatusCode
			appendNumber(count)
		}
		if len(body) < w.wire.layout("SearchPackagePayloadOffset")+w.wire.layout("SearchShardHeaderSize") ||
			u32(body, 0) != w.wire.layout("SearchPackageMagic") || u32(body, 4) != w.wire.layout("SearchArtifactVersion") {
			return errors.New("invalid corpus package header")
		}
		evidence.Bytes += len(body)
		appendNumber(len(body))
		sum.Write(body)
		if page == evidence.Pages {
			break
		}
	}
	ordered := sortArticlesDesc(published, func(a article) time.Time { return a.CreatedAt })
	appendNumber(len(ordered))
	var coordinates [20]byte
	for _, entry := range ordered {
		binary.LittleEndian.PutUint32(coordinates[:], uint32(entry.ID))
		binary.LittleEndian.PutUint64(coordinates[4:], 1)
		binary.LittleEndian.PutUint64(coordinates[12:], uint64(entry.PublicationID))
		sum.Write(coordinates[:])
		if entry.CategoryID > 0 {
			fmt.Fprintf(sum, "C%d:%d:%s", entry.CategoryID, len(utf16.Encode([]rune(entry.CategoryName))), entry.CategoryName)
		}
		for i, id := range entry.TagIDs {
			fmt.Fprintf(sum, "T%d:%d:%s", id, len(utf16.Encode([]rune(entry.TagNames[i]))), entry.TagNames[i])
		}
	}
	expected := strconv.FormatUint(binary.LittleEndian.Uint64(sum.Sum(nil))&0x7fffffffffffffff, 10)
	if observed != expected {
		return fmt.Errorf("public generation differs from fixture coordinates and corpus bytes: observed %s, computed %s", observed, expected)
	}
	head, err := request(http.MethodHead, "?generation="+expected)
	if err != nil {
		return fmt.Errorf("search corpus generation check: %w", err)
	}
	defer head.Body.Close()
	values, counts := head.Header.Values(generationHeader), head.Header.Values(pagesHeader)
	valid := evidence.Status == http.StatusOK && head.StatusCode == http.StatusNoContent && len(counts) == 1 && counts[0] == strconv.Itoa(evidence.Pages) ||
		evidence.Status == http.StatusServiceUnavailable && head.StatusCode == http.StatusServiceUnavailable && len(counts) == 0
	if head.Proto != "HTTP/1.1" || head.Header.Get("Cache-Control") != "no-store" || len(values) != 1 || values[0] != expected || !valid {
		return errors.New("corpus generation HEAD could not confirm the preflight snapshot")
	}
	w.generation, w.corpus = expected, evidence
	return nil
}

func canonicalGeneration(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 63)
	return err == nil && strconv.FormatUint(parsed, 10) == value
}

// One outstanding request per connection avoids hidden HTTP client retries and pipelining.
// ReadResponse still handles Content-Length and chunked bodies using the standard parser.
type connection struct {
	origin    *url.URL
	tlsConfig *tls.Config
	conn      net.Conn
	reader    *bufio.Reader
	served    bool
	carryover bool
	reuse     connectionReuse
}

func (c *connection) close() {
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.served = false
}

func closePool(pool []connection) {
	for i := range pool {
		pool[i].close()
	}
}

func (c *connection) request(path string, deadline time.Time, inspect func(*http.Response) error) (int, error) {
	request, err := encodeRequest(c.origin, path)
	if err != nil {
		return 0, err
	}
	return c.requestEncoded(request, deadline, nil, inspect)
}

func newLoadRequest(ctx context.Context, method string, origin *url.URL, path string) (*http.Request, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, errors.New("load request path must be relative to the selected origin")
	}
	return http.NewRequestWithContext(ctx, method, origin.String()+path, nil)
}

func encodeRequest(origin *url.URL, path string) ([]byte, error) {
	req, err := newLoadRequest(context.Background(), http.MethodGet, origin, path)
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
	err := c.connectContext(context.Background(), deadline)
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
	} else {
		c.served = true
	}
	response.Body.Close()
	return response.StatusCode, err
}

func (c *connection) connectContext(ctx context.Context, deadline time.Time) error {
	if c.conn != nil {
		return nil
	}
	dialer := &net.Dialer{Deadline: deadline}
	var socket net.Conn
	var err error
	if c.origin.Scheme == "https" {
		socket, err = (&tls.Dialer{NetDialer: dialer, Config: c.tlsConfig}).DialContext(ctx, "tcp", c.origin.Host)
	} else {
		socket, err = dialer.DialContext(ctx, "tcp", c.origin.Host)
	}
	if err != nil {
		return err
	}
	c.conn = socket
	c.reader = bufio.NewReaderSize(socket, 8192)
	return nil
}

func metadata(response *http.Response, class route, generation, header string) (string, error) {
	expected := "text/html"
	if class == homeAEDS || class == detailAEDS {
		expected = "application/octet-stream"
	}
	if response.StatusCode != 200 || !checkMediaAndEncoding(response, expected) {
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
				body, err := readBoundedBody(response.Body, maxBody)
				if err != nil || len(body) == 0 {
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

func crc16(payload []byte) uint16 {
	crc := uint16(0xffff)
	for _, value := range payload {
		crc = (crc >> 8) ^ wireTable[byte(crc)^value]
	}
	return crc
}

func u32(data []byte, off int) int   { return int(binary.LittleEndian.Uint32(data[off:])) }
func u64(data []byte, off int) int64 { return int64(binary.LittleEndian.Uint64(data[off:])) }

func (w workload) parseFrame(body []byte, name string) ([]byte, error) {
	size := w.wire.header("HeaderSize")
	if len(body) < size || u32(body, 0) != w.wire.header("Magic") || int(body[w.wire.header("VersionOffset")]) != w.wire.header("Version") || int(body[w.wire.header("LengthOffset")]) != size ||
		binary.LittleEndian.Uint16(body[w.wire.header("FlagsOffset"):]) != 0 || int(binary.LittleEndian.Uint16(body[w.wire.header("TypeOffset"):])) != w.wire.FrameTypes[name] || u32(body, w.wire.header("PayloadLengthOffset")) != len(body)-size {
		return nil, errors.New("AEDS envelope does not match the expected frame")
	}
	payload := body[size:]
	if crc16(payload) != binary.LittleEndian.Uint16(body[w.wire.header("CrcOffset"):]) {
		return nil, errors.New("AEDS CRC differs")
	}
	return payload, nil
}

func (w workload) parseApiError(body []byte, expectedStatus int) ([]byte, error) {
	payload, err := w.parseFrame(body, "ApiError")
	if err != nil {
		return nil, err
	}
	if len(payload) != w.wire.layout("ErrorBytes") || u32(payload, w.wire.layout("ErrorStatusOffset")) != expectedStatus {
		return nil, errors.New("AEDS error status differs")
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
		cursor, length := w.wire.layout("ArticleListCursorOffset"), w.wire.layout("ArticleListCursorLengthOffset")
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

func (w workload) matchArticleRecord(frame, record, blob []byte, a article, coordsOff, titleOff, catOff, tagStart, tagCount int) bool {
	return u32(record, 0) == a.ID && u64(record, coordsOff) == 1 && u64(record, coordsOff+12) == a.PublicationID &&
		string(textSlot(record, titleOff, blob)) == a.Title &&
		u32(record, w.wire.layout("ArticleCategoryIdOffset")) == a.CategoryID &&
		string(textSlot(record, catOff, blob)) == a.CategoryName &&
		matchesTags(frame, blob, tagStart, tagCount, w.wire.layout("ArticleTagRecordSize"), a)
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
		if !found || !closed || len(text) != a.HTMLBodyBytes || sha256Hex(text) != a.HTMLBodySHA {
			return errors.New("HTML detail body differs from the seeded article")
		}
		return nil
	}
	if class == detailAEDS {
		a := w.articles[id-1]
		frame, err := w.parseFrame(body, "ArticleDetail")
		if err != nil {
			return err
		}
		if len(frame) < 44 || u32(frame, 0) != w.wire.layout("ArticleDetailV5Magic") || u32(frame, 4) != w.wire.layout("ArticleDetailV5Version") {
			return errors.New("unexpected AEDS article detail layout")
		}
		start, lenRecord, blobOffset := u32(frame, 12), u32(frame, 16), u32(frame, 36)
		if start != w.wire.layout("ArticleDetailHeaderSize") || lenRecord != w.wire.layout("ArticleDetailV5RecordSize") || blobOffset < start+lenRecord || blobOffset > len(frame) {
			return errors.New("invalid AEDS detail offsets")
		}
		record, blob := frame[start:start+lenRecord], frame[blobOffset:]
		text := textSlot(record, w.wire.layout("ArticleDetailBodyOffset"), blob)
		if !w.matchArticleRecord(frame, record, blob, a, w.wire.layout("ArticleDetailCoordinatesOffset"), w.wire.layout("ArticleDetailTitleOffset"), w.wire.layout("ArticleDetailCategoryOffset"), u32(frame, 20), u32(frame, 24)) ||
			len(text) != a.BodyBytes || sha256Hex(text) != a.BodySHA256 {
			return errors.New("AEDS detail identity, projection coordinate or content differs")
		}
		return nil
	}
	frame, err := w.parseFrame(body, "ArticleList")
	if err != nil {
		return err
	}
	if len(frame) < 29 || u32(frame, 0) != w.wire.layout("ArticleListCursorMagic") || u32(frame, 4) != w.wire.layout("ArticleListCursorVersion") ||
		u32(frame, w.wire.layout("ArticleListTotalOffset")) != len(w.articles)-20 {
		return errors.New("unexpected AEDS list layout or total")
	}
	meta := w.wire.layout("ArticleListCursorOffset") + u32(frame, w.wire.layout("ArticleListCursorLengthOffset"))
	if meta > len(frame)-12 || u32(frame, meta) != len(newest) {
		return errors.New("AEDS list count or cursor differs")
	}
	blobStart := meta + 12
	blobEnd := blobStart + u32(frame, meta+8)
	size, tagSize := w.wire.layout("ArticleListRecordSizeCurrent"), w.wire.layout("ArticleTagRecordSize")
	tagOffset := blobEnd + size*len(newest)
	if tagOffset+tagSize*u32(frame, meta+4) != len(frame) {
		return errors.New("AEDS list has invalid boundaries")
	}
	blob := frame[blobStart:blobEnd]
	for i, a := range newest {
		record := frame[blobEnd+i*size : blobEnd+(i+1)*size]
		firstTag := tagOffset + tagSize*u32(record, w.wire.layout("ArticleListTagStartOffset"))
		if !w.matchArticleRecord(frame, record, blob, a, w.wire.layout("ArticleListCoordinatesOffset"), w.wire.layout("ArticleListTitleOffset"), w.wire.layout("ArticleListCategoryOffset"), firstTag, u32(record, w.wire.layout("ArticleListTagCountOffset"))) {
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

const (
	slowRequestThreshold = 20 * time.Millisecond
	slowRequestLimit     = 4096
)

type slowRequest struct {
	Route        string     `json:"route"`
	Planned      time.Time  `json:"plannedUtc"`
	Worker       time.Time  `json:"workerUtc"`
	Written      *time.Time `json:"writtenUtc,omitempty"`
	Headers      *time.Time `json:"headersUtc,omitempty"`
	Body         *time.Time `json:"bodyUtc,omitempty"`
	Finished     time.Time  `json:"finishedUtc"`
	Milliseconds float64    `json:"milliseconds"`
	Phases       slowPhases `json:"phasesMs"`
	Status       int        `json:"status"`
	Bytes        int64      `json:"bytes"`
	Error        string     `json:"error,omitempty"`
}

type slowPhases struct {
	PlannedToWorker float64  `json:"plannedToWorker"`
	WorkerToWrite   *float64 `json:"workerToWrite,omitempty"`
	WriteToHeaders  *float64 `json:"writeToHeaders,omitempty"`
	HeadersToBody   *float64 `json:"headersToBody,omitempty"`
	BodyToFinish    *float64 `json:"bodyToFinish,omitempty"`
}

type slowRequests struct {
	ThresholdMS float64       `json:"thresholdMs"`
	Omitted     int           `json:"omitted"`
	Requests    []slowRequest `json:"requests"`
}

func (s *slowRequests) record(r result) {
	if r.reason == "dropped" || r.latency < slowRequestThreshold {
		return
	}
	if len(s.Requests) == slowRequestLimit {
		s.Omitted++
		return
	}
	timestamp := func(value time.Time) *time.Time {
		if value.IsZero() {
			return nil
		}
		utc := value.UTC()
		return &utc
	}
	between := func(first, last time.Time) *float64 {
		if first.IsZero() || last.IsZero() {
			return nil
		}
		ms := millis(last.Sub(first))
		return &ms
	}
	worker := r.planned.Add(r.dispatch)
	s.Requests = append(s.Requests, slowRequest{Route: names[r.class], Planned: r.planned.UTC(),
		Worker: worker.UTC(), Written: timestamp(r.written), Headers: timestamp(r.headers),
		Body: timestamp(r.bodyCompleted), Finished: r.completed.UTC(), Milliseconds: millis(r.latency),
		Phases: slowPhases{millis(r.dispatch), between(worker, r.written), between(r.written, r.headers),
			between(r.headers, r.bodyCompleted), between(r.bodyCompleted, r.completed)},
		Status: r.status, Bytes: r.bytes, Error: r.reason})
}

func worker(c *connection, jobs <-chan job, permits <-chan struct{}, output chan<- result, w workload) {
	copyBuffer := make([]byte, 32*1024)
	readBuffer := make([]byte, 0, 48*1024)
	for j := range jobs {
		firstCarried := c.carryover && c.reuse.Attempted == 0
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
			var sampledBuf *bytes.Buffer
			if j.sample {
				sampledBuf = bytes.NewBuffer(readBuffer[:0])
				received, readErr = io.Copy(sampledBuf, source)
				r.sampled = true
			} else {
				received, readErr = io.CopyBuffer(io.Discard, source, copyBuffer)
			}
			if readErr == nil && received <= int64(j.length) {
				r.bodyCompleted = time.Now()
			}
			if readErr != nil {
				return readErr
			}
			if sampledBuf != nil {
				if digest, digestErr := w.checksum(j.class, sampledBuf.Bytes()); digestErr != nil || digest != j.digest {
					r.reason = "digest"
					return errors.New("response checksum differs")
				}
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
		if c.carryover {
			valid := r.reason == "" && r.dialStarted.IsZero()
			c.reuse.AttemptedRequests++
			if valid {
				c.reuse.ValidatedRequests++
			}
			if firstCarried {
				c.reuse.Attempted++
				if valid {
					c.reuse.Validated++
				}
			}
			// The transport survives only while the original socket is present.
			// There are no retries inside an attempt.
			c.carryover = c.conn != nil && r.dialStarted.IsZero()
		}
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

func loadConnections(origin *url.URL, config *tls.Config, count int) []connection {
	pool := make([]connection, count)
	for i := range pool {
		pool[i] = connection{origin: origin, tlsConfig: config}
	}
	return pool
}

type connectionReuse struct {
	Retained          int `json:"retainedAfterWarmup"`
	Attempted         int `json:"attemptedOnRetained"`
	Validated         int `json:"validatedOnRetained"`
	AttemptedRequests int `json:"requestsAttemptedOnRetained"`
	ValidatedRequests int `json:"requestsValidatedOnRetained"`
}

func retainWarmSockets(pool []connection) {
	for i := range pool {
		c := &pool[i]
		c.carryover = c.conn != nil && c.served
		if c.carryover {
			c.reuse.Retained = 1
		}
	}
}

func continuity(pool []connection) connectionReuse {
	var total connectionReuse
	for i := range pool {
		r := pool[i].reuse
		total.Retained += r.Retained
		total.Attempted += r.Attempted
		total.Validated += r.Validated
		total.AttemptedRequests += r.AttemptedRequests
		total.ValidatedRequests += r.ValidatedRequests
	}
	return total
}

func connectPool(ctx context.Context, pool []connection, label string) error {
	for i := range pool {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := pool[i].connectContext(ctx, time.Now().Add(requestLimit)); err != nil {
			return fmt.Errorf("%s %d: %w", label, i+1, err)
		}
	}
	return nil
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
	admissions map[int]*supplySecond // Producer owns this map.
	transfers  map[int]*supplySecond // Collector owns this map.
}

func bucketAt(buckets map[int]*supplySecond, epoch, at time.Time) *supplySecond {
	second := int(at.Sub(epoch) / time.Second)
	slot := buckets[second]
	if slot == nil {
		slot = new(supplySecond)
		buckets[second] = slot
	}
	return slot
}

func (s supplyTimeline) recordAdmission(at, planned time.Time, admitted bool, observedOutstanding int) {
	slot := bucketAt(s.admissions, s.epoch, at)
	slot.SchedulerAwake++
	slot.MaxWakeDelayMS = max(slot.MaxWakeDelayMS, millis(at.Sub(planned)))
	if admitted {
		slot.Admitted++
		slot.OutstandingPeak = max(slot.OutstandingPeak, observedOutstanding)
	} else {
		slot.Dropped++
		slot.OutstandingPeak = maxInFlight
	}
}

func (s supplyTimeline) recordTransfer(r result) {
	if r.reason == "dropped" {
		return
	}
	transfer := func(at time.Time) *supplySecond { return bucketAt(s.transfers, s.epoch, at) }
	if !r.dialStarted.IsZero() {
		transfer(r.dialStarted).DialsStarted++
		finished := transfer(r.dialFinished)
		if r.dialConnected {
			finished.DialsConnected++
		} else {
			finished.DialsFailed++
		}
		finished.MaxDialDurationMS = max(finished.MaxDialDurationMS, millis(r.dialFinished.Sub(r.dialStarted)))
	}
	done := transfer(r.completed)
	done.Finished++
	if !r.bodyCompleted.IsZero() {
		transfer(r.bodyCompleted).BodiesRead++
	}
	if !r.headers.IsZero() {
		transfer(r.headers).HeadersRead++
	}
	if r.reason == "" {
		done.Correct++
	}
	if !r.written.IsZero() {
		written := transfer(r.written)
		written.SocketWritten++
		written.MaxWriteDelayMS = max(written.MaxWriteDelayMS, millis(r.written.Sub(r.planned)))
		if !r.bodyCompleted.IsZero() {
			body := transfer(r.bodyCompleted)
			body.MaxAfterWriteMS = max(body.MaxAfterWriteMS, millis(r.bodyCompleted.Sub(r.written)))
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
		if slot := s.transfers[second]; slot != nil {
			*row = *slot
		}
		if slot := s.admissions[second]; slot != nil {
			row.SchedulerAwake, row.Admitted, row.Dropped = slot.SchedulerAwake, slot.Admitted, slot.Dropped
			row.OutstandingPeak, row.MaxWakeDelayMS = slot.OutstandingPeak, slot.MaxWakeDelayMS
		}
		row.Second = second
		if second < s.seconds {
			row.Planned = rate
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
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
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

func measure(ctx context.Context, pool []connection, w workload, rate, seconds int, slow *slowRequests) (time.Time, time.Duration, map[string]*stats, []supplySecond) {
	// Admission counts queued jobs and active requests against the same limit.
	// A worker briefly between reads must not turn unused capacity into an offered drop.
	jobs, permits, results := make(chan job, maxInFlight), make(chan struct{}, maxInFlight), make(chan result, maxInFlight)
	var workers, collector sync.WaitGroup
	totals := map[string]*stats{}
	for _, name := range append(names[:], "all") {
		totals[name] = &stats{Status: map[int]int{}, Errors: map[string]int{}}
	}
	timeline := supplyTimeline{seconds: seconds, admissions: make(map[int]*supplySecond), transfers: make(map[int]*supplySecond)}
	collector.Go(func() {
		for r := range results {
			totals["all"].add(r)
			totals[names[r.class]].add(r)
			timeline.recordTransfer(r)
			if slow != nil {
				slow.record(r)
			}
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
	drained := time.Since(started)
	close(results)
	collector.Wait()
	for _, s := range totals {
		s.P50MS, s.P95MS, s.P99MS = s.latency.percentile(s.OK, 50), s.latency.percentile(s.OK, 95), s.latency.percentile(s.OK, 99)
		s.Dispatch = s.dispatch.percentile(s.Sent, 99)
	}
	return started.UTC(), drained, totals, timeline.rows(rate)
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

func captureStage(ctx context.Context, pool []connection, w workload, rate, seconds int, report map[string]any, slow *slowRequests) {
	producerBefore, beforeErr := sampleProducer()
	measured, elapsed, totals, timeline := measure(ctx, pool, w, rate, seconds, slow)
	finished := time.Now().UTC()
	producerAfter, afterErr := sampleProducer()
	all := totals["all"]
	report["measurementStartedAt"], report["measurementCompletedAt"], report["routes"] = measured, finished, totals
	report["measurementElapsedSeconds"], report["supplyBySecond"] = elapsed.Seconds(), timeline
	if slow != nil {
		report["slowRequests"] = slow
	}
	report["schedulerUnreached"] = rate*seconds - all.Sent - all.Dropped
	if supplyErr := errors.Join(beforeErr, afterErr); supplyErr != nil {
		report["producerResourceError"] = supplyErr.Error()
	} else {
		report["producerBefore"], report["producerAfter"] = producerBefore, producerAfter
	}
	report["correctPerSecond"] = float64(all.OK) / float64(seconds)
	report["requestedRate"], report["seconds"], report["expected"] = rate, seconds, rate*seconds
	if ctx.Err() != nil || all.OK != all.Sent || all.Dropped != 0 {
		// Preserve full raw evidence regardless of stage outcome. The runner evaluates the production thresholds.
		report["measurement"] = "errors_or_dropped"
	} else {
		report["measurement"] = "all_correct"
	}
}

func parseLoadTarget(target, privateTarget, authority string) (*url.URL, error) {
	if target != "" && privateTarget != "" {
		return nil, errors.New("choose exactly one of -target or -private-target")
	}
	value := target
	if privateTarget != "" {
		value = privateTarget
	}
	origin, err := url.Parse(value)
	if err != nil || origin.Host == "" || origin.Port() == "" || origin.User != nil || origin.Path != "" ||
		origin.RawQuery != "" || origin.Fragment != "" || (origin.Scheme != "http" && origin.Scheme != "https") {
		return nil, errors.New("target requires an explicit HTTP or HTTPS origin and port")
	}
	if privateTarget == "" {
		if !net.ParseIP(origin.Hostname()).IsLoopback() {
			return nil, errors.New("-target requires a literal loopback address")
		}
		return origin, nil
	}
	host, port := origin.Hostname(), origin.Port()
	address, addressErr := netip.ParseAddr(host)
	portNumber, portErr := strconv.ParseUint(port, 10, 16)
	if addressErr != nil || !address.IsPrivate() || address.Is4In6() || address.Zone() != "" ||
		portErr != nil || portNumber == 0 || port != strconv.FormatUint(portNumber, 10) ||
		origin.Host != net.JoinHostPort(host, port) || origin.ForceQuery || strings.Contains(value, "#") {
		return nil, errors.New("-private-target requires a literal RFC1918 IPv4 or ULA IPv6 address and numeric port")
	}
	if origin.Scheme == "https" && authority == "" {
		return nil, errors.New("a private HTTPS target requires an explicit -ca PEM")
	}
	return origin, nil
}

func run() int {
	target := flag.String("target", "", "explicit loopback HTTP or HTTPS origin with port")
	privateTarget := flag.String("private-target", "", "explicit isolated private HTTP or HTTPS origin with port")
	authority := flag.String("ca", "", "PEM authority for an isolated TLS run (required with HTTPS -private-target)")
	fixture := flag.String("fixture", "", "seed.py manifest")
	wire := flag.String("wire", "src/Contracts/wire.schema.json", "checked-in wire contract")
	rate := flag.Int("rate", 0, "scheduled requests per second (0 performs preflight only)")
	seconds := flag.Int("seconds", 60, "seconds per measured stage")
	coldLog := flag.String("cold-log", "", "existing private Kestrel log from a fresh, owned cold-cache run")
	coldPressure := flag.Bool("cold-pressure", false, "after standard cold rounds run overload and actual disconnect diagnostics")
	runtimeControl := flag.String("runtime-control", "", "private run directory for a runtime measurement boundary")
	captureSlow := flag.Bool("slow-requests", false, "record bounded 20ms client spans in a marked peak diagnostic")
	preconnect := flag.Bool("preconnect-tls", false, "establish the 256 TLS connections serially before load")
	sharedWarmup := flag.Int("shared-warmup-seconds", 0, "2000/s warmup on the measured pool, 30 seconds or 3-second diagnostic")
	output := flag.String("out", "", "new JSON evidence path")
	flag.Parse()
	fail := func(err error) int { fmt.Fprintln(os.Stderr, err); return 1 }
	origin, err := parseLoadTarget(*target, *privateTarget, *authority)
	if err != nil {
		return fail(err)
	}
	for _, check := range []struct {
		invalid bool
		message string
	}{
		{*coldPressure && *coldLog == "", "cold pressure requires the private cold-cache log"},
		{*fixture == "" || *output == "" || *rate < 0 || *rate > 11000 || *seconds < 1 || *seconds > 900, "fixture and output required; rate 0..11000, seconds 1..900"},
		{*privateTarget != "" && (*coldLog != "" || *runtimeControl != ""), "cold-cache logs and runtime measurement markers require the local runner"},
		{origin.Scheme != "https" && *authority != "", "a certificate authority requires an HTTPS target"},
		{*preconnect && (origin.Scheme != "https" || *rate == 0), "TLS preconnection requires an HTTPS target and hot load"},
		{*sharedWarmup != 0 && (*rate == 0 || *preconnect || *sharedWarmup != 30 && *sharedWarmup != 3), "shared warmup requires hot load, no TLS preconnection, and 30 or 3 seconds"},
		{*captureSlow && (*runtimeControl == "" || *sharedWarmup != 30 || *rate != 10500 || *seconds != 60 || *coldLog != ""), "slow request recording requires the marked 10500/s peak diagnostic with 30 seconds of shared warmup"},
		{*coldLog != "" && (origin.Scheme != "http" || *rate != 0), "cold sampling requires a fresh direct origin and no hot load"},
	} {
		if check.invalid {
			return fail(errors.New(check.message))
		}
	}
	w, err := readWorkload(*fixture, *wire)
	if err != nil {
		return fail(err)
	}
	if origin.Scheme == "https" {
		if w.tlsConfig, err = loadTLSConfig(*authority); err != nil {
			return fail(err)
		}
	}
	out, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fail(err)
	}
	defer out.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	started := time.Now().UTC()
	err = verifyGeneration(ctx, origin, &w, w.articles[:len(w.articles)-20])
	if *coldLog != "" && err == nil {
		return runCold(ctx, origin, w, *coldLog, *coldPressure, out)
	}
	if err == nil {
		err = preflight(ctx, origin, &w)
	}
	report := map[string]any{
		"startedAt": started, "target": origin.String(), "generation": w.generation, "fixtureSha256": w.fixture,
		"requestedRate": *rate, "seconds": *seconds, "preflight": "pass", "protocol": w.protocol, "tlsVersion": w.tlsVersion,
		"connectionPolicy": "fresh-pool",
	}
	if *privateTarget != "" {
		report["targetScope"] = "explicit-private-literal"
	}
	if w.generation != "" {
		report["corpusPreflight"] = w.corpus
	}
	if *sharedWarmup != 0 {
		report["connectionPolicy"] = "carry-from-warmup"
	} else if *preconnect {
		report["connectionPolicy"] = "serial-tls-preconnect"
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
	pool := loadConnections(origin, w.tlsConfig, maxInFlight)
	defer closePool(pool)
	if code == 0 && *sharedWarmup != 0 {
		warm := map[string]any{"pid": os.Getpid(), "target": origin.String(), "generation": w.generation, "fixtureSha256": w.fixture}
		captureStage(ctx, pool, w, 2000, *sharedWarmup, warm, nil)
		report["warmup"] = warm
		retainWarmSockets(pool)
		report["connectionReuse"] = continuity(pool)
		if ctx.Err() != nil {
			err, code = ctx.Err(), 1
			report["measurement"], report["measurementError"] = "warmup_cancelled", err.Error()
		}
	}
	if code == 0 && *preconnect {
		warmed := time.Now()
		if err = connectPool(ctx, pool, "TLS connection"); err != nil {
			report["measurement"], report["measurementError"] = "preconnect_failed", err.Error()
			code = 1
		} else {
			report["preconnectedTLS"], report["preconnectSeconds"] = len(pool), time.Since(warmed).Seconds()
		}
	}
	if code == 0 && *rate > 0 && *runtimeControl != "" {
		if err = startRuntimeMeasurement(ctx, *runtimeControl); err != nil {
			report["measurement"], report["measurementError"] = "runtime_boundary_failed", err.Error()
			code = 1
		}
	}
	if code == 0 && *rate > 0 {
		var slow *slowRequests
		if *captureSlow {
			slow = &slowRequests{ThresholdMS: millis(slowRequestThreshold), Requests: []slowRequest{}}
		}
		captureStage(ctx, pool, w, *rate, *seconds, report, slow)
		if *sharedWarmup != 0 {
			report["connectionReuse"], report["pid"] = continuity(pool), os.Getpid()
		}
	}
	report["finishedAt"] = time.Now().UTC()
	if writeErr := writeIndentedJSON(out, report); writeErr != nil {
		return fail(writeErr)
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
