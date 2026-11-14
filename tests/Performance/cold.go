package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const coldFanOut = 64

type cacheEvent struct {
	Event      string `json:"event"`
	ID         int    `json:"articleId"`
	Generation string `json:"generation"`
	Pending    int    `json:"pending"`
	Active     int    `json:"active"`
	ElapsedUS  int    `json:"elapsedUs"`
}

type coldResponse struct {
	Path       string  `json:"path"`
	ID         int     `json:"articleId"`
	Status     int     `json:"status"`
	Bytes      int     `json:"bytes"`
	DispatchMS float64 `json:"dispatchMs"`
	LatencyMS  float64 `json:"latencyMs"`
	Error      string  `json:"error,omitempty"`
	Aborted    bool    `json:"clientAborted,omitempty"`
}

type coldRound struct {
	Name         string         `json:"name"`
	Offered      int            `json:"offered"`
	StartedAt    time.Time      `json:"startedAt"`
	FinishedAt   time.Time      `json:"finishedAt"`
	Events       []cacheEvent   `json:"cacheEvents"`
	Responses    []coldResponse `json:"responses"`
	ColdStarts   map[int]int    `json:"coldStarts"`
	CacheActions map[string]int `json:"cacheActions"`
	HTTPStatus   map[int]int    `json:"httpStatus"`
	PendingMax   int            `json:"pendingMax"`
	ActiveMax    int            `json:"activeMax"`
	P95MS        float64        `json:"p95Ms"`
	P99MS        float64        `json:"p99Ms"`
}

var cacheEventLine = regexp.MustCompile(`Public article cache ([a-z-]+) article=([0-9]+) generation=([0-9]+) pending=([0-9]+) active=([0-9]+) elapsed_us=([0-9]+)`)

func readCacheEvents(path string) ([]cacheEvent, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	events := []cacheEvent{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		match := cacheEventLine.FindStringSubmatch(scanner.Text())
		if match == nil {
			continue
		}
		id, _ := strconv.Atoi(match[2])
		pending, _ := strconv.Atoi(match[4])
		active, _ := strconv.Atoi(match[5])
		elapsed, _ := strconv.Atoi(match[6])
		events = append(events, cacheEvent{match[1], id, match[3], pending, active, elapsed})
	}
	return events, scanner.Err()
}

// The server initially materializes the 1,200 newest articles by creation time.
// The fixture includes the dedicated withdrawal cases in the published ordering.
func coldRounds(w workload, pressure bool) ([]coldRound, [][]expectation, error) {
	byCreation := append([]article(nil), w.articles[:len(w.articles)-20]...)
	sort.Slice(byCreation, func(i, j int) bool {
		if byCreation[i].CreatedAt.Equal(byCreation[j].CreatedAt) {
			return byCreation[i].ID > byCreation[j].ID
		}
		return byCreation[i].CreatedAt.After(byCreation[j].CreatedAt)
	})
	cold := []article{}
	for _, entry := range byCreation[hotDetails:] {
		if entry.State == "public" {
			cold = append(cold, entry)
		}
	}
	selected := make(map[int]bool)
	rounds := []coldRound{}
	paths := [][]expectation{}
	for _, size := range []int{2048, 8192, 32768} {
		for _, entry := range cold {
			if entry.BodyBytes == size {
				selected[entry.ID] = true
				rounds = append(rounds, coldRound{Name: fmt.Sprintf("same-key-%d-bytes", size)})
				paths = append(paths, coldPaths(w, []article{entry}))
				break
			}
		}
	}
	if len(rounds) != 3 {
		return nil, nil, errors.New("cold fixture does not contain all three body sizes")
	}
	distinct := []article{}
	for _, entry := range cold {
		// Use the largest standard bodies to expose parallel rendering without
		// changing the fixture or adding an artificial render delay.
		if entry.BodyBytes == 32768 && !selected[entry.ID] {
			distinct = append(distinct, entry)
			if len(distinct) == coldFanOut {
				break
			}
		}
	}
	if len(distinct) != coldFanOut {
		return nil, nil, errors.New("cold fixture does not contain 64 distinct large entries")
	}
	rounds = append(rounds, coldRound{Name: "distinct-keys-32768-bytes"})
	paths = append(paths, coldPaths(w, distinct))
	if pressure {
		for _, entry := range distinct {
			selected[entry.ID] = true
		}
		distinct = nil
		for _, entry := range cold {
			if entry.BodyBytes == 32768 && !selected[entry.ID] {
				distinct = append(distinct, entry)
				if len(distinct) == maxInFlight {
					break
				}
			}
		}
		if len(distinct) != maxInFlight {
			return nil, nil, errors.New("cold fixture does not contain 256 additional distinct large entries")
		}
		rounds = append(rounds, coldRound{Name: "overload-256-distinct-keys-with-client-aborts"})
		paths = append(paths, coldPaths(w, distinct))
	}
	return rounds, paths, nil
}

func coldPaths(w workload, articles []article) []expectation {
	paths := make([]expectation, max(coldFanOut, len(articles)))
	for index := range paths {
		id := articles[index%len(articles)].ID
		path, class := "/article/"+strconv.Itoa(id), detailHTML
		if index%2 == 1 {
			path = strings.Replace(w.wire.Routes["PublicArticle"], "{id}", strconv.Itoa(id), 1)
			class = detailAEDS
		}
		paths[index] = expectation{class: class, path: path, id: id}
	}
	return paths
}

func validateColdResponse(w workload, target expectation, response *http.Response, body []byte) error {
	if response.Proto != "HTTP/1.1" || len(body) == 0 || len(body) > maxBody {
		return errors.New("response protocol or bounded body differs")
	}
	if response.StatusCode != http.StatusServiceUnavailable {
		if _, err := metadata(response, target.class, w.generation, w.wire.Headers["SearchIndexGeneration"]); err != nil {
			return err
		}
		return w.validate(target.class, target.id, body)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		return errors.New("temporary response can be cached")
	}
	kind, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil {
		return err
	}
	if target.class == detailHTML {
		if kind != "text/plain" || string(body) != "This operation is temporarily unavailable." {
			return errors.New("temporary response is not the public HTML error")
		}
		return nil
	}
	if kind != "application/octet-stream" {
		return errors.New("temporary response is not an AEDS frame")
	}
	payload, err := w.parseFrame(body, "ApiError")
	if err != nil {
		return err
	}
	if len(payload) != number(w.wire.Layouts, "ErrorBytes") ||
		u32(payload, number(w.wire.Layouts, "ErrorStatusOffset")) != response.StatusCode {
		return errors.New("AEDS error status differs")
	}
	return nil
}

func releaseColdRound(ctx context.Context, origin *url.URL, w workload, round *coldRound, jobs []expectation, pressure bool) error {
	clients := make([]connection, len(jobs))
	round.Offered = len(jobs)
	dialer := net.Dialer{Timeout: requestLimit}
	for index := range clients {
		socket, err := dialer.DialContext(ctx, "tcp", origin.Host)
		if err != nil {
			return err
		}
		clients[index] = connection{origin: origin, conn: socket, reader: bufio.NewReaderSize(socket, 8192)}
		defer clients[index].close()
	}
	responses := make([]coldResponse, len(jobs))
	gate := make(chan struct{})
	var requests sync.WaitGroup
	for index, target := range jobs {
		requests.Go(func() {
			<-gate
			started := time.Now()
			row := coldResponse{Path: target.path, ID: target.id, DispatchMS: millis(started.Sub(round.StartedAt))}
			if pressure && index%8 == (index/8)%2 {
				row.Aborted = true
				if err := abortColdRequest(&clients[index], target.path, round.StartedAt.Add(requestLimit)); err != nil {
					row.Error = err.Error()
				}
				row.LatencyMS = millis(time.Since(round.StartedAt))
				responses[index] = row
				return
			}
			var body []byte
			var header *http.Response
			status, err := clients[index].request(target.path, round.StartedAt.Add(requestLimit), func(response *http.Response) error {
				header = response
				var err error
				body, err = io.ReadAll(io.LimitReader(response.Body, maxBody+1))
				return err
			})
			row.LatencyMS = millis(time.Since(round.StartedAt))
			row.Status, row.Bytes = status, len(body)
			if err == nil {
				err = validateColdResponse(w, target, header, body)
			}
			if err != nil {
				row.Error = err.Error()
			}
			responses[index] = row
		})
	}
	round.StartedAt = time.Now()
	close(gate)
	requests.Wait()
	round.StartedAt = round.StartedAt.UTC()
	round.FinishedAt, round.Responses = time.Now().UTC(), responses
	return ctx.Err()
}

func abortColdRequest(client *connection, path string, deadline time.Time) error {
	conn := client.conn.(*net.TCPConn)
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	if err := conn.SetLinger(0); err != nil {
		return err
	}
	req, err := http.NewRequest("GET", client.origin.String()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept-Encoding", "identity")
	if err := req.Write(conn); err != nil {
		return err
	}
	// Keep the request pending long enough for Kestrel to start admission in a
	// real burst. The reset also exercises requests that have already finished.
	time.Sleep(20 * time.Millisecond)
	client.close()
	return nil
}

func millis(value time.Duration) float64 { return float64(value) / float64(time.Millisecond) }

func summarizeColdRound(round *coldRound, selected []expectation, events []cacheEvent, generation string) error {
	keys := map[int]bool{}
	for _, entry := range selected {
		keys[entry.id] = true
	}
	round.ColdStarts, round.CacheActions, round.HTTPStatus = map[int]int{}, map[string]int{}, map[int]int{}
	var invalid []error
	admitted := map[int]int{}
	finished := map[int]int{}
	ready := map[int]int{}
	for _, event := range events {
		round.Events = append(round.Events, event)
		round.CacheActions[event.Event]++
		round.ActiveMax = max(round.ActiveMax, event.Active)
		round.PendingMax = max(round.PendingMax, event.Pending)
		if event.Generation != generation || !keys[event.ID] {
			invalid = append(invalid, fmt.Errorf("unexpected cache event for article %d or generation %s", event.ID, event.Generation))
		}
		switch event.Event {
		case "admitted":
			admitted[event.ID]++
		case "started":
			round.ColdStarts[event.ID]++
			if event.ElapsedUS > 750_000 {
				invalid = append(invalid, fmt.Errorf("article %d began rendering outside the 750 ms budget", event.ID))
			}
		case "ready":
			ready[event.ID]++
			if event.ElapsedUS > 2_000_000 {
				invalid = append(invalid, fmt.Errorf("article %d became ready outside the 2 s budget", event.ID))
			}
		case "finished":
			finished[event.ID]++
		}
	}
	for id := range keys {
		if admitted[id] != 1 || finished[id] != 1 || ready[id] != 1 || round.ColdStarts[id] != 1 {
			invalid = append(invalid, fmt.Errorf("article %d did not complete exactly one cold render", id))
		}
	}
	if len(events) == 0 || events[len(events)-1].Pending != 0 || events[len(events)-1].Active != 0 ||
		round.PendingMax > 64 || round.ActiveMax > 4 {
		invalid = append(invalid, errors.New("cache counters did not satisfy the concurrency or drain bounds"))
	}
	var timings histogram
	for _, response := range round.Responses {
		round.HTTPStatus[response.Status]++
		timings.add(time.Duration(response.LatencyMS * float64(time.Millisecond)))
		switch {
		case response.Error != "":
			invalid = append(invalid, fmt.Errorf("GET %s (%d): %s", response.Path, response.Status, response.Error))
		case response.LatencyMS > 750:
			invalid = append(invalid, fmt.Errorf("GET %s (%d) took %.1f ms end to end", response.Path, response.Status, response.LatencyMS))
		case response.Status != http.StatusOK:
			invalid = append(invalid, fmt.Errorf("GET %s received a valid %d but normal fixture did not succeed", response.Path, response.Status))
		}
	}
	round.P95MS = timings.percentile(len(round.Responses), 95)
	round.P99MS = timings.percentile(len(round.Responses), 99)
	return errors.Join(invalid...)
}

func summarizePressure(round *coldRound, selected []expectation, events []cacheEvent, generation string) error {
	aborted := map[int]bool{}
	rejected := map[int]bool{}
	active := map[int]bool{}
	round.ColdStarts, round.CacheActions, round.HTTPStatus = map[int]int{}, map[string]int{}, map[int]int{}
	var unexpected []error
	known := map[int]bool{}
	for _, request := range selected {
		known[request.id] = true
	}
	for _, response := range round.Responses {
		if response.Aborted {
			aborted[response.ID] = true
		}
	}
	var timings histogram
	measured := 0
	for _, event := range events {
		round.Events = append(round.Events, event)
		round.CacheActions[event.Event]++
		round.ActiveMax = max(round.ActiveMax, event.Active)
		round.PendingMax = max(round.PendingMax, event.Pending)
		if !known[event.ID] || event.Generation != generation {
			unexpected = append(unexpected, fmt.Errorf("unexpected cold pressure event for article %d or generation %s", event.ID, event.Generation))
		}
		switch event.Event {
		case "admitted":
			if active[event.ID] {
				unexpected = append(unexpected, fmt.Errorf("article %d had simultaneous admissions", event.ID))
			}
			active[event.ID] = true
		case "finished":
			delete(active, event.ID)
		case "admission-rejected":
			if event.Pending != 64 {
				unexpected = append(unexpected, fmt.Errorf("article %d refused before 64 pending keys", event.ID))
			}
			rejected[event.ID] = true
		case "wait-timeout", "worker-timeout", "render-timeout":
			rejected[event.ID] = true
		case "started":
			round.ColdStarts[event.ID]++
			if event.ElapsedUS > 750_000 {
				unexpected = append(unexpected, fmt.Errorf("article %d began rendering outside the 750 ms budget", event.ID))
			}
		case "ready":
			if event.ElapsedUS > 2_000_000 {
				unexpected = append(unexpected, fmt.Errorf("article %d became ready outside the 2 s budget", event.ID))
			}
		case "wait-cancelled":
			if !aborted[event.ID] {
				unexpected = append(unexpected, fmt.Errorf("uncancelled client unexpectedly lost article %d", event.ID))
			}
		}
	}
	if len(active) != 0 || round.ActiveMax > 4 || round.PendingMax > 64 ||
		len(events) == 0 || events[len(events)-1].Pending != 0 || events[len(events)-1].Active != 0 {
		unexpected = append(unexpected, errors.New("overload did not satisfy cache limits or drain"))
	}
	for id, count := range round.ColdStarts {
		if count != 1 {
			unexpected = append(unexpected, fmt.Errorf("article %d rendered %d times", id, count))
		}
	}
	for _, response := range round.Responses {
		if response.Error != "" {
			unexpected = append(unexpected, fmt.Errorf("GET %s (%d): %s", response.Path, response.Status, response.Error))
		}
		if response.Aborted {
			continue
		}
		round.HTTPStatus[response.Status]++
		timings.add(time.Duration(response.LatencyMS * float64(time.Millisecond)))
		measured++
		if response.Status == 200 && round.ColdStarts[response.ID] != 1 || response.Status == 503 && !rejected[response.ID] {
			unexpected = append(unexpected, fmt.Errorf("GET %s (%d) has no matching cache result", response.Path, response.Status))
		}
		if response.LatencyMS > 750 {
			unexpected = append(unexpected, fmt.Errorf("GET %s (%d) took %.1f ms end to end", response.Path, response.Status, response.LatencyMS))
		}
	}
	round.P95MS = timings.percentile(measured, 95)
	round.P99MS = timings.percentile(measured, 99)
	return errors.Join(unexpected...)
}

func coldEventsAfterRound(logPath string, seen int, grace time.Duration) ([]cacheEvent, error) {
	deadline := time.Now().Add(time.Second)
	quietUntil := time.Now().Add(grace)
	lastCount := seen
	for {
		events, err := readCacheEvents(logPath)
		if err != nil || time.Now().After(deadline) {
			return events, err
		}
		if len(events) != lastCount {
			quietUntil = time.Now().Add(grace)
			lastCount = len(events)
		}
		if time.Now().After(quietUntil) && len(events) > seen && events[len(events)-1].Pending == 0 {
			return events, nil
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func runCold(ctx context.Context, origin *url.URL, w workload, logPath string, pressure bool, out io.Writer) int {
	started := time.Now().UTC()
	rounds, paths, err := coldRounds(w, pressure)
	var prior []cacheEvent
	if err == nil {
		prior, err = readCacheEvents(logPath)
	}
	if err == nil && len(prior) != 0 {
		err = errors.New("Kestrel had already handled cold cache requests")
	}
	observed := len(prior)
	completed := 0
	var observedPressure *coldRound
	var retry *coldRound
	for index := range rounds {
		if err != nil {
			break
		}
		round := &rounds[index]
		overload := pressure && index == len(rounds)-1
		var events []cacheEvent
		err = releaseColdRound(ctx, origin, w, round, paths[index], overload)
		if err == nil {
			grace := time.Duration(0)
			if overload {
				grace = 50 * time.Millisecond
			}
			events, err = coldEventsAfterRound(logPath, observed, grace)
		}
		if err == nil && len(events) < observed {
			err = errors.New("Kestrel cache evidence was truncated")
		} else if err == nil && overload {
			err = summarizePressure(round, paths[index], events[observed:], w.generation)
			observedPressure = round
			if err == nil {
				observed = len(events)
				for index, response := range round.Responses {
					if response.Status != 503 {
						continue
					}
					retry = &coldRound{Name: "retry-after-admission-rejection"}
					path := paths[len(paths)-1][index : index+1]
					err = releaseColdRound(ctx, origin, w, retry, path, false)
					if err == nil {
						events, err = coldEventsAfterRound(logPath, observed, 0)
					}
					if err == nil && len(events) >= observed {
						err = summarizeColdRound(retry, path, events[observed:], w.generation)
					} else if err == nil {
						err = errors.New("Kestrel cache evidence was truncated during retry")
					}
					break
				}
			}
		} else if err == nil {
			err = summarizeColdRound(round, paths[index], events[observed:], w.generation)
			observed = len(events)
		}
		completed++
	}
	report := map[string]any{
		"startedAt": started, "finishedAt": time.Now().UTC(), "target": origin.String(),
		"generation": w.generation, "fixtureSha256": w.fixture,
		"rounds": rounds[:completed], "measurement": "all_correct",
	}
	inconclusive := false
	if err == nil && observedPressure != nil {
		counts := observedPressure.CacheActions
		report["pressureObserved"] = map[string]bool{"admissionRejection": counts["admission-rejected"] != 0, "serverCancellation": counts["wait-cancelled"] != 0}
		inconclusive = counts["admission-rejected"] == 0 || counts["wait-cancelled"] == 0
		if inconclusive {
			report["measurement"] = "pressure_not_fully_exercised"
		} else {
			report["measurement"] = "pressure_exercised"
		}
	}
	if retry != nil {
		report["retry"] = retry
	}
	if err != nil {
		report["error"], report["measurement"] = err.Error(), "failed"
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	if writeErr := encoder.Encode(report); writeErr != nil {
		fmt.Fprintln(os.Stderr, writeErr)
		return 1
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if inconclusive {
		fmt.Fprintln(os.Stderr, "Pressure did not produce both an admission rejection and a server-side cancellation.")
		return 2
	}
	return 0
}
