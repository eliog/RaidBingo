import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRequest } from "../shared/request.ts";

test("a write with no payload is still a JSON request (#19)", () => {
  // The server refuses any POST to /api/* that is not application/json.
  assert.deepEqual(apiRequest(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.deepEqual(apiRequest(undefined), apiRequest());
  assert.deepEqual(apiRequest(null), apiRequest());
});

test("a payload is sent as JSON, and a read carries no body (#19)", () => {
  assert.deepEqual(apiRequest({ item: 7 }), {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"item":7}',
  });
  assert.deepEqual(apiRequest(null, "GET"), { method: "GET", headers: {} });
  assert.equal(apiRequest({}, "DELETE").headers["content-type"], "application/json");
});
