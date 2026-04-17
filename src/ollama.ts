// Ollama helpers shared across the reviewer path and session pre-flight
// checks. Kept separate from reviewer.ts so session.ts can depend on the
// reachability check without also pulling in reviewer.ts's state/audit
// dependencies (which test helpers mock narrowly).

export interface OllamaReachabilityResult {
  reachable: boolean;
  host: string;
  error?: string;
}

export async function checkOllamaReachable(
  timeoutMs: number = 2000,
): Promise<OllamaReachabilityResult> {
  const host = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${host}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        reachable: false,
        host,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }
    return { reachable: true, host };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      host,
      error: name === "AbortError" ? `timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
