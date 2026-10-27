import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAnswer } from "../server/ai";
import { normalizeSearchToolFilters } from "../server/search-tool-filters";

const settings = {
  provider: "compatible", model: "test-model",
  credentials: { compatible: { apiKey: "test-key", config: { baseURL: "https://provider.test/v1" } } },
};

for (const filters of [null, { createdAfter: null, createdBefore: null, fileTypes: null, access: null, folderId: null }]) {
  test(`nullable tool filters reach retrieval without a fabricated folder (${filters === null ? "whole object" : "fields"})`, async () => {
    let calls = 0, searches = 0;
    const answer = await generateAnswer(settings, "Answer from documents.", [{ role: "user", content: "Find a fact in the attached document." }], async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const first = calls++ === 0;
      if (first) {
        const tool = body.tools.find((item: any) => item.function.name === "search_documents");
        assert.match(JSON.stringify(tool.function.parameters.properties.filters), /"null"/);
      }
      return Response.json({
        id: "test", object: "chat.completion", created: 1, model: "test-model",
        choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message: first
          ? { role: "assistant", content: null, tool_calls: [{ id: "search", type: "function", function: { name: "search_documents", arguments: JSON.stringify({ query: "Find a fact", filters }) } }] }
          : { role: "assistant", content: "The fact is supported [1]." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }, { signal: AbortSignal.timeout(10000), searchDocuments: async (_query, _signal, actual) => {
      searches++;
      assert.deepEqual(actual, filters === null ? undefined : {});
      return { sources: [{ content: "A supported fact.", reference: "[1]" }] };
    } });
    assert.equal(searches, 1);
    assert.match(answer, /supported/);
  });
}

test("explicit restrictions survive normalization and invalid restrictions are rejected", () => {
  const folderId = "81a03ef4-242b-4789-8a9f-6cfb2596b476";
  assert.deepEqual(normalizeSearchToolFilters({folderId, createdAfter: "2026-01-01", access: ["private"], fileTypes: null}), {folderId, createdAfter: "2026-01-01", access: ["private"]});
  assert.throws(() => normalizeSearchToolFilters({createdAfter: "2026-12-31", createdBefore: "2026-01-01"}));
  assert.deepEqual(normalizeSearchToolFilters({folderId: "00000000-0000-0000-0000-000000000000"}), {folderId: "00000000-0000-0000-0000-000000000000"});
});
