"use client";

/** Browser-side helper for the admin API: JSON in, JSON out, errors as messages. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : `request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}
