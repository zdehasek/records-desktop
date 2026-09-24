import assert from "node:assert/strict"
import test from "node:test"
import {
  HOST_REQUEST_TYPE,
  READY_TYPE,
  parseReadyLine,
  routeFromArguments,
  validateHostRequest,
  validateReadyMessage,
  validateRoute
} from "../../desktop/electron/protocol.js"

const token = "a".repeat(64)

test("Electron launch routes accept only known routes", () => {
  assert.equal(validateRoute("photos"), "photos")
  assert.equal(validateRoute("javascript:alert(1)"), "today")
  assert.equal(routeFromArguments(["records", "week"]), "week")
  assert.equal(routeFromArguments(["records://open/on-this-day-story"]), null)
  assert.equal(routeFromArguments(["https://example.com/photos"]), null)
  assert.equal(routeFromArguments(["file:///tmp/settings"]), null)
  assert.equal(routeFromArguments(["records://open/not-a-route"]), null)
})

test("backend readiness is bound to the private loopback token", () => {
  const expected = {
    url: `http://127.0.0.1:4321/${token}/`,
    profile: { id: "family_2", name: "Family" }
  }
  assert.deepEqual(validateReadyMessage(expected, token), expected)
  assert.deepEqual(
    validateReadyMessage({ type: READY_TYPE, ...expected }, token),
    expected
  )
  assert.deepEqual(
    parseReadyLine(`RECORDS_READY ${JSON.stringify(expected)}`, token),
    expected
  )
  assert.throws(
    () =>
      validateReadyMessage(
        { ...expected, url: `http://localhost:4321/${token}/` },
        token
      ),
    /invalid private URL/
  )
  assert.throws(
    () => parseReadyLine("RECORDS_READY nope", token),
    /malformed readiness JSON/
  )
})

test("backend host requests are typed and strictly allowlisted", () => {
  assert.deepEqual(
    validateHostRequest({
      type: HOST_REQUEST_TYPE,
      id: 1,
      method: "openFile",
      args: ["/tmp/photo.jpg"]
    }),
    {
      type: HOST_REQUEST_TYPE,
      id: 1,
      method: "openFile",
      args: ["/tmp/photo.jpg"]
    }
  )
  assert.deepEqual(
    validateHostRequest({
      type: HOST_REQUEST_TYPE,
      id: 2,
      method: "sendNotification",
      args: [
        {
          title: "A memory is waiting",
          body: "Open Records",
          route: "on-this-day-story"
        }
      ]
    }).args[0].route,
    "on-this-day-story"
  )
  assert.throws(
    () =>
      validateHostRequest({
        type: HOST_REQUEST_TYPE,
        id: 3,
        method: "openFile",
        args: ["relative"]
      }),
    /absolute/
  )
  assert.throws(
    () =>
      validateHostRequest({
        type: HOST_REQUEST_TYPE,
        id: 4,
        method: "sendNotification",
        args: [{ title: "x", body: "y", route: "javascript:bad" }]
      }),
    /route/
  )
  assert.throws(
    () =>
      validateHostRequest({
        type: HOST_REQUEST_TYPE,
        id: 5,
        method: "execute",
        args: []
      }),
    /Unknown/
  )
})
