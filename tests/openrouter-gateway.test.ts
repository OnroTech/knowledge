import assert from "node:assert/strict";
import { test } from "node:test";
import { getDecisionConnection } from "../server/decision-provider";
import { createJev } from "../server/jev";

test("OpenRouter routes Jev's existing decision protocol with the organization's key", async () => {
  const connection = getDecisionConnection({
    decisionProvider: "typesafe", jevGateway: "openrouter", jevKey: "org-router-key",
  });
  assert.ok(connection);
  const jev = createJev(connection, async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer org-router-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions.placement.type, "choice");
    return Response.json({ answers: { placement: { type: "choice", probabilities: { a: 0.8, b: 0.2 } } } });
  });
  assert.deepEqual(await jev.decide("evidence", [{id:"a",text:"A"},{id:"b",text:"B"}], "Choose"), { a: 0.8, b: 0.2 });
});

test("Direct TypeSafe remains the default and unconfigured organizations stay disabled", async () => {
  assert.equal(getDecisionConnection({ jevGateway: "openrouter" }), undefined);
  const connection = getDecisionConnection({ jevKey: "typesafe-key" });
  assert.deepEqual(connection, { provider: "typesafe", key: "typesafe-key" });
  const jev = createJev(connection!, async (url) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    return Response.json({ answers: { placement: { probabilities: { a: 1, b: 0 } } } });
  });
  await jev.decide("evidence", [{id:"a",text:"A"},{id:"b",text:"B"}], "Choose");
});

test("OpenRouter preserves fail-closed validation of decision distributions", async () => {
  const jev = createJev({ provider: "typesafe", key: "key", gateway: "openrouter" }, async () =>
    Response.json({ answers: { placement: { probabilities: { a: 0.1, b: 0.1 } } } }));
  await assert.rejects(jev.decide("evidence", [{id:"a",text:"A"},{id:"b",text:"B"}], "Choose"), /invalid placement distribution/);
});
