import { describe, expect, test } from "bun:test"
import { isAuthorized, parseBearer, tokenMatches } from "../src/daemon/auth"

describe("parseBearer", () => {
  test("extracts token from valid header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123")
  })
  test("case-insensitive scheme", () => {
    expect(parseBearer("bearer xyz")).toBe("xyz")
  })
  test("rejects missing scheme", () => {
    expect(parseBearer("abc")).toBeUndefined()
  })
  test("rejects empty/null", () => {
    expect(parseBearer(null)).toBeUndefined()
    expect(parseBearer("")).toBeUndefined()
    expect(parseBearer(undefined)).toBeUndefined()
  })
  test("rejects basic auth header", () => {
    expect(parseBearer("Basic dXNlcjpwYXNz")).toBeUndefined()
  })
})

describe("tokenMatches", () => {
  test("returns true for identical tokens", () => {
    expect(tokenMatches("hunter2", "hunter2")).toBe(true)
  })
  test("returns false for different tokens", () => {
    expect(tokenMatches("hunter2", "hunter3")).toBe(false)
  })
  test("returns false for tokens of different lengths (sha256 compare handles this)", () => {
    expect(tokenMatches("short", "this-is-much-longer-than-the-expected")).toBe(false)
  })
  test("returns false when one side is empty", () => {
    expect(tokenMatches("hunter2", "")).toBe(false)
    expect(tokenMatches("", "anything")).toBe(false)
  })
  test("does not throw on length mismatch (regression on raw timingSafeEqual)", () => {
    expect(() => tokenMatches("a", "bbbbb")).not.toThrow()
  })
})

describe("isAuthorized", () => {
  function reqWith(authHeader: string | undefined): Request {
    const headers: Record<string, string> = {}
    if (authHeader) headers.Authorization = authHeader
    return new Request("http://x/", { headers })
  }

  test("authorises with correct token", () => {
    expect(isAuthorized("hunter2", reqWith("Bearer hunter2"))).toBe(true)
  })
  test("rejects without Authorization header", () => {
    expect(isAuthorized("hunter2", reqWith(undefined))).toBe(false)
  })
  test("rejects with wrong token", () => {
    expect(isAuthorized("hunter2", reqWith("Bearer wrong"))).toBe(false)
  })
  test("rejects with non-Bearer scheme", () => {
    expect(isAuthorized("hunter2", reqWith("Basic dXNlcjpwYXNz"))).toBe(false)
  })
})
