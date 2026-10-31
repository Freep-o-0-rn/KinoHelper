/* KinoHelper playback diagnostics — read-only, run in DevTools Console.
 * Does not save data, send requests, change playback or interact with the extension.
 * Select the document/frame context in DevTools before running.
 */
(() => {
  const KEY = "__kinoPlaybackDiagnostics";
  if (globalThis[KEY]?.stop) globalThis[KEY].stop();
  const listeners = [];
  const seen = new WeakSet();
  const log = (type, data = {}) => console.log("[KinoDiag]", type, data);
  const videoDetails = (v) => ({
    timeSeconds: Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 10) / 10 : null,
    durationSeconds: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
    paused: v.paused,
    ended: v.ended,
    readyState: v.readyState,
    seekableRanges: v.seekable.length,
    srcPresent: Boolean(v.currentSrc || v.src)
  });
  function watch(v) {
    if (seen.has(v)) return;
    seen.add(v);
    log("video-detected", videoDetails(v));
    let lastTick = 0;
    for (const event of ["play", "pause", "loadedmetadata", "durationchange", "seeking", "seeked", "ended", "timeupdate"]) {
      const handler = () => {
        if (event === "timeupdate" && Date.now() - lastTick < 5000) return;
        if (event === "timeupdate") lastTick = Date.now();
        log(event, videoDetails(v));
      };
      v.addEventListener(event, handler);
      listeners.push(() => v.removeEventListener(event, handler));
    }
  }
  function scan(root = document) {
    for (const v of root.querySelectorAll("video")) watch(v);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) scan(el.shadowRoot);
  }
  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  const iframeCount = document.querySelectorAll("iframe").length;
  log("started", { frameOrigin: location.origin, iframeCount, videoCount: document.querySelectorAll("video").length });
  const stop = () => {
    observer.disconnect();
    listeners.splice(0).forEach(fn => fn());
    delete globalThis[KEY];
    log("stopped");
  };
  globalThis[KEY] = { stop };
  console.log("[KinoDiag] Stop with __kinoPlaybackDiagnostics.stop(). No URLs or video data uploaded.");
})();
