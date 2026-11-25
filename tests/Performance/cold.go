package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
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
	atoi := func(s string) int { v, _ := strconv.Atoi(s); return v }
	for scanner.Scan() {
		match := cacheEventLine.FindStringSubmatch(scanner.Text())
		if match != nil {
			events = append(events, cacheEvent{match[1], atoi(match[2]), match[3], atoi(match[4]), atoi(match[5]), atoi(match[6])})
		}
	}
	return events, scanner.Err()
}

// The server initially materializes the 1,200 newest articles by creation time.
// The fixture includes the dedicated withdrawal cases in the published ordering.
func coldRounds(w workload, pressure bool) ([]coldRound, [][]expectation, error) {
	byCreation := sortArticlesDesc(w.articles[:len(w.articles)-20], func(a article) time.Time { return a.CreatedAt })
	var cold []article
	for _, entry := range byCreation[hotDetails:] {
		if entry.State == "public" {
			cold = append(cold, entry)
		}
	}
	specs := []struct {
		name, missing string
		size, count   int
	}{
		{"same-key-2048-bytes", "cold fixture does not contain all three body sizes", 2048, 1},
		{"same-key-8192-bytes", "cold fixture does not contain all three body sizes", 8192, 1},
		{"same-key-32768-bytes", "cold fixture does not contain all three body sizes", 32768, 1},
		// Use the largest standard bodies to expose parallel rendering without an artificial delay.
		{"distinct-keys-32768-bytes", "cold fixture does not contain 64 distinct large entries", 32768, coldFanOut},
	}
	if pressure {
		specs = append(specs, struct {
			name, missing string
			size, count   int
		}{"overload-256-distinct-keys-with-client-aborts", "cold fixture does not contain 256 additional distinct large entries", 32768, maxInFlight})
	}
	selected := make(map[int]bool)
	rounds, paths := make([]coldRound, 0, len(specs)), make([][]expectation, 0, len(specs))
	for _, spec := range specs {
		var picked []article
		for _, entry := range cold {
			if entry.BodyBytes == spec.size && !selected[entry.ID] {
				picked = append(picked, entry)
				if len(picked) == spec.count {
					break
				}
			}
		}
		if len(picked) != spec.count {
			return nil, nil, errors.New(spec.missing)
		}
		for _, entry := range picked {
			selected[entry.ID] = true
		}
		rounds = append(rounds, coldRound{Name: spec.name})
		paths = append(paths, coldPaths(w, picked))
	}
	return rounds, paths, nil
}

func coldPaths(w workload, articles []article) []expectation {
	paths := make([]expectation, max(coldFanOut, len(articles)))
	for index := range paths {
		class := detailHTML
		if index%2 == 1 {
			class = detailAEDS
		}
		paths[index] = w.detailExpectation(class, articles[index%len(articles)].ID)
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
	_, err = w.parseApiError(body, response.StatusCode)
	return err
}

func releaseColdRound(ctx context.Context, origin *url.URL, w workload, round *coldRound, jobs []expectation, pressure bool) error {
	clients := loadConnections(origin, nil, len(jobs))
	defer closePool(clients)
	round.Offered = len(jobs)
	if err := connectPool(ctx, clients, "cold connection"); err != nil {
		return err
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
	req, err := encodeRequest(client.origin, path)
	if err == nil {
		err = errors.Join(conn.SetWriteDeadline(deadline), conn.SetLinger(0))
	}
	if err != nil {
		return err
	}
	if _, err := conn.Write(req); err != nil {
		return err
	}
	// Keep the request pending long enough for Kestrel to start admission in a
	// real burst. The reset also exercises requests that have already finished.
	time.Sleep(20 * time.Millisecond)
	client.close()
	return nil
}

func millis(value time.Duration) float64 { return float64(value) / float64(time.Millisecond) }

func summarizeColdRound(round *coldRound, selected []expectation, events []cacheEvent, generation string, pressure bool) error {
	known, aborted := map[int]bool{}, map[int]bool{}
	for _, entry := range selected {
		known[entry.id] = true
	}
	eventKind := "cache"
	if pressure {
		eventKind = "cold pressure"
		for _, response := range round.Responses {
			if response.Aborted {
				aborted[response.ID] = true
			}
		}
	}
	round.ColdStarts, round.CacheActions, round.HTTPStatus = map[int]int{}, map[string]int{}, map[int]int{}
	admitted, finished, ready := map[int]int{}, map[int]int{}, map[int]int{}
	active, rejected := map[int]bool{}, map[int]bool{}
	var invalid []error
	check := func(bad bool, format string, args ...any) {
		if bad {
			invalid = append(invalid, fmt.Errorf(format, args...))
		}
	}
	for _, event := range events {
		round.Events = append(round.Events, event)
		round.CacheActions[event.Event]++
		round.ActiveMax, round.PendingMax = max(round.ActiveMax, event.Active), max(round.PendingMax, event.Pending)
		check(!known[event.ID] || event.Generation != generation, "unexpected %s event for article %d or generation %s", eventKind, event.ID, event.Generation)
		switch event.Event {
		case "admitted":
			admitted[event.ID]++
			check(pressure && active[event.ID], "article %d had simultaneous admissions", event.ID)
			active[event.ID] = true
		case "finished":
			finished[event.ID]++
			delete(active, event.ID)
		case "started":
			round.ColdStarts[event.ID]++
			check(event.ElapsedUS > 750_000, "article %d began rendering outside the 750 ms budget", event.ID)
		case "ready":
			ready[event.ID]++
			check(event.ElapsedUS > 2_000_000, "article %d became ready outside the 2 s budget", event.ID)
		case "admission-rejected":
			check(pressure && event.Pending != 64, "article %d refused before 64 pending keys", event.ID)
			rejected[event.ID] = true
		case "wait-timeout", "worker-timeout", "render-timeout":
			rejected[event.ID] = true
		case "wait-cancelled":
			check(pressure && !aborted[event.ID], "uncancelled client unexpectedly lost article %d", event.ID)
		}
	}
	drained := len(events) > 0 && events[len(events)-1].Pending == 0 && events[len(events)-1].Active == 0 &&
		round.PendingMax <= 64 && round.ActiveMax <= 4
	check(!drained || (pressure && len(active) != 0), "cache counters did not satisfy the concurrency or drain bounds")
	if pressure {
		for id, count := range round.ColdStarts {
			check(count != 1, "article %d rendered %d times", id, count)
		}
	} else {
		for id := range known {
			check(admitted[id] != 1 || finished[id] != 1 || ready[id] != 1 || round.ColdStarts[id] != 1,
				"article %d did not complete exactly one cold render", id)
		}
	}
	var timings histogram
	measured := 0
	for _, response := range round.Responses {
		check(response.Error != "", "GET %s (%d): %s", response.Path, response.Status, response.Error)
		if pressure && response.Aborted {
			continue
		}
		round.HTTPStatus[response.Status]++
		timings.add(time.Duration(response.LatencyMS * float64(time.Millisecond)))
		measured++
		if !pressure && response.Error != "" {
			continue
		}
		check(pressure && (response.Status == 200 && round.ColdStarts[response.ID] != 1 || response.Status == 503 && !rejected[response.ID]),
			"GET %s (%d) has no matching cache result", response.Path, response.Status)
		if response.LatencyMS > 750 {
			check(true, "GET %s (%d) took %.1f ms end to end", response.Path, response.Status, response.LatencyMS)
		} else {
			check(!pressure && response.Status != http.StatusOK, "GET %s received a valid %d but normal fixture did not succeed", response.Path, response.Status)
		}
	}
	round.P95MS, round.P99MS = timings.percentile(measured, 95), timings.percentile(measured, 99)
	return errors.Join(invalid...)
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
	observed, completed := len(prior), 0
	var observedPressure, retry *coldRound
	runRound := func(round *coldRound, jobs []expectation, overload bool, truncated string) error {
		if err := releaseColdRound(ctx, origin, w, round, jobs, overload); err != nil {
			return err
		}
		var grace time.Duration
		if overload {
			grace = 50 * time.Millisecond
		}
		events, err := coldEventsAfterRound(logPath, observed, grace)
		if err != nil {
			return err
		}
		if len(events) < observed {
			return errors.New(truncated)
		}
		err = summarizeColdRound(round, jobs, events[observed:], w.generation, overload)
		observed = len(events)
		return err
	}
	for index := range rounds {
		if err != nil {
			break
		}
		round, jobs := &rounds[index], paths[index]
		overload := pressure && index == len(rounds)-1
		err = runRound(round, jobs, overload, "Kestrel cache evidence was truncated")
		completed++
		if err == nil && overload {
			observedPressure = round
			for index, response := range round.Responses {
				if response.Status == 503 {
					retry = &coldRound{Name: "retry-after-admission-rejection"}
					err = runRound(retry, jobs[index:index+1], false, "Kestrel cache evidence was truncated during retry")
					break
				}
			}
		}
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
	fail := func(code int, msg any) int { fmt.Fprintln(os.Stderr, msg); return code }
	if writeErr := writeIndentedJSON(out, report); writeErr != nil {
		return fail(1, writeErr)
	}
	if err != nil {
		return fail(1, err)
	}
	if inconclusive {
		return fail(2, "Pressure did not produce both an admission rejection and a server-side cancellation.")
	}
	return 0
}
