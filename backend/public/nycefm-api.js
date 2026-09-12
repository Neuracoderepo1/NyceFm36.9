/* NYCE FM production browser API bridge. No secrets belong in this file. */
export class NyceFmApi {
  constructor(baseUrl = "") { this.baseUrl = baseUrl.replace(/\/$/, ""); }
  async request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) {
      let detail = null; try { detail = await res.json(); } catch {}
      const err = new Error(detail?.error?.message || `NYCE FM request failed (${res.status})`);
      err.status = res.status; err.code = detail?.error?.code; err.requestId = detail?.error?.request_id;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  me() { return this.request("/api/auth/me"); }
  login(email, password) { return this.request("/api/auth/login", { method:"POST", body:JSON.stringify({email,password}) }); }
  logout() { return this.request("/api/auth/logout", { method:"POST" }); }
  broadcastState(stationId) { return this.request(`/api/broadcast/state${stationId ? `?stationId=${encodeURIComponent(stationId)}` : ""}`); }
  control(action, expectedControlRevision, reason, stationId) {
    return this.request("/api/broadcast/control", { method:"POST", body:JSON.stringify({stationId,action,expectedControlRevision,reason}) });
  }
  queue(mediaAssetId, stationId, source="dj") {
    return this.request("/api/broadcast/queue", { method:"POST", body:JSON.stringify({stationId,mediaAssetId,source}) });
  }
  aiActions(stationId) { return this.request(`/api/ai/actions${stationId ? `?stationId=${encodeURIComponent(stationId)}` : ""}`); }
  executeAiAction(actionId) { return this.request(`/api/ai/actions/${encodeURIComponent(actionId)}/execute`, {method:"POST",body:"{}"}); }
  subscribeBroadcast(stationId, onState, onError) {
    const url=`${this.baseUrl}/api/broadcast/control-stream${stationId ? `?stationId=${encodeURIComponent(stationId)}` : ""}`;
    const es=new EventSource(url, { withCredentials:true });
    es.addEventListener("broadcast", e => { try { onState(JSON.parse(e.data)); } catch(err) { onError?.(err); } });
    es.onerror = () => onError?.(new Error("Broadcast event stream disconnected"));
    return () => es.close();
  }
}
