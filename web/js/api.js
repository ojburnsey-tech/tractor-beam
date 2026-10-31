// JSON client for the Library API. Every write carries the CSRF header the
// server requires. A 401 on a signed-in request means the session ended.

export class ApiError extends Error {
  constructor(message, status, code, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

let onSignedOut = () => {};
export function handleSignedOut(callback) {
  onSignedOut = callback;
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = "grabber";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Can't reach your Library. Check your connection.", 0, "offline");
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    if (response.status === 401 && data?.code === "signed-out") onSignedOut();
    throw new ApiError(data?.error || `Something went wrong (HTTP ${response.status}).`, response.status, data?.code, data || {});
  }
  return data || {};
}

export const get = (path, options) => api(path, options);
export const post = (path, body = {}, options) => api(path, { ...options, method: "POST", body });
export const patch = (path, body = {}, options) => api(path, { ...options, method: "PATCH", body });
export const del = (path, body, options) => api(path, { ...options, method: "DELETE", body });
