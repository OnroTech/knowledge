import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { generateAnswer } from "../server/ai";

const schema = z.object({ folders: z.array(z.object({ name: z.string().min(1), description: z.string().min(1) }).strict()).min(1).max(2) }).strict();
const settings = { provider: "compatible", model: "test-model", credentials: { compatible: { apiKey: "test-key", config: { baseURL: "https://openrouter.ai/api/v1" } } } };
for (const valid of [true, false]) {
  test(`folder naming requests structured JSON and ${valid ? "accepts valid" : "rejects malformed"} output`, async () => {
    const expected = { folders: [{ name: "Gardening", description: "Growing plants." }] };
    const result = generateAnswer(settings, "Propose a folder.", [{ role: "user", content: "Synthetic garden guide" }], async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format.type, "json_schema");
      assert.ok(body.response_format.json_schema.schema.properties.folders);
      assert.equal(body.max_tokens, 3000);
      return Response.json({ id: "test", object: "chat.completion", created: 1, model: "test-model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: valid ? JSON.stringify(expected) : '{"folders":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }, { signal: AbortSignal.timeout(10000), maxOutputTokens: 3000, outputSchema: schema });
    if (valid) assert.deepEqual(JSON.parse(await result), expected);
    else await assert.rejects(result, /provider could not complete/);
  });
}
