import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { createAuthentication } from "../server/auth";
import type { Store } from "../server/db";
import { testDatabase } from "./database";
import { authMailbox } from "./auth-mailbox";
import { waitForJobs } from "./jobs";

test("verification bypass refuses public signup", (t) => {
  t.mock.property(process, "env", {
    ...process.env,
    ALLOW_SIGNUP: "true",
    AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
  });
  assert.throws(
    () =>
      createAuthentication({} as Store, {
        directory: "/tmp",
        origin: "https://private.test",
      }),
    /Public signup must be disabled/,
  );
});

test(
  "private signup bypasses email while preserving password and invitation admission",
  { timeout: 120000 },
  async (t) => {
    t.mock.property(process, "env", {
      ...process.env,
      NODE_ENV: "production",
      ALLOW_SIGNUP: "false",
      AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
      BOOTSTRAP_TOKEN: "test-private-bootstrap",
      BETTER_AUTH_SECRET: "private-test-secret-that-is-long-enough",
    });
    const origin = "https://private.test";
    const mailbox = authMailbox(origin);
    const database = await testDatabase();
    const directory = mkdtempSync(join(tmpdir(), "jevbox-private-"));
    const runtime = await createApp({
      databaseUrl: database.url,
      directory,
      origin,
      rateLimits: false,
      workers: ["auth-email"],
      sendAuthEmail: mailbox.sendAuthEmail,
    });
    const server = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const password = "private-test-password-123!";
    async function request(path: string, body?: unknown, cookie = "") {
      const result = await fetch(base + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Origin: origin,
          "X-Jevbox-Request": "1",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await waitForJobs(runtime, ["auth-email"]);
      return result;
    }
    const cookies = (r: Response) =>
      r.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    try {
      const signup = {
        email: "admin@private.test",
        name: "Admin",
        organization: "Private",
        password,
      };
      assert.equal((await request("/auth/sign-up/email", signup)).status, 403);
      const created = await request("/auth/sign-up/email", {
        ...signup,
        bootstrapToken: "test-private-bootstrap",
      });
      assert.equal(created.status, 200, await created.clone().text());
      assert.equal((await created.json()).user.emailVerified, true);
      assert.equal(mailbox.messages.length, 0);
      assert.equal(
        (
          await request("/auth/sign-in/email", {
            email: signup.email,
            password: "wrong-password-123",
          })
        ).status,
        401,
      );
      const login = await request("/auth/sign-in/email", {
        email: signup.email,
        password,
      });
      assert.equal(login.status, 200, await login.clone().text());
      const admin = cookies(login);
      assert.ok(admin);
      assert.equal((await request("/me", undefined, admin)).status, 200);
      assert.equal((await request("/me")).status, 401);
      assert.equal(
        (
          await request("/auth/sign-up/email", {
            ...signup,
            email: "other@private.test",
            bootstrapToken: "test-private-bootstrap",
          })
        ).status,
        403,
      );
      const invitation = await request(
        "/auth/organization/invite-member",
        { email: "member@private.test", role: "member" },
        admin,
      );
      assert.equal(invitation.status, 200, await invitation.clone().text());
      const { id } = await invitation.json();
      assert.equal(
        (
          await request("/auth/sign-up/email", {
            name: "Wrong",
            email: "wrong@private.test",
            password,
            invite: id,
          })
        ).status,
        400,
      );
      const member = await request("/auth/sign-up/email", {
        name: "Member",
        email: "member@private.test",
        password,
        invite: id,
      });
      assert.equal(member.status, 200, await member.clone().text());
      assert.equal((await member.json()).user.emailVerified, true);
      const duplicate = await request("/auth/sign-up/email", {
        name: "Member",
        email: "member@private.test",
        password: "different-password-123!",
        invite: id,
      });
      assert.equal(duplicate.status, 200);
      assert.equal(
        (await duplicate.json()).user.emailVerified,
        true,
        "Duplicate signup must not direct the client to disabled email verification",
      );
      assert.equal(
        duplicate.headers.get("set-cookie"),
        null,
        "Duplicate signup must still require password authentication",
      );
      assert.equal(
        (
          await request("/auth/sign-in/email", {
            email: "member@private.test",
            password: "different-password-123!",
          })
        ).status,
        401,
        "Duplicate signup must not replace the existing password",
      );
      assert.equal(
        (
          await request("/auth/organization/accept-invitation", {
            invitationId: id,
          })
        ).status,
        401,
      );
      const memberLogin = await request("/auth/sign-in/email", {
        email: "member@private.test",
        password,
      });
      assert.equal(memberLogin.status, 200);
      assert.equal(
        (
          await request(
            "/auth/organization/accept-invitation",
            { invitationId: id },
            cookies(memberLogin),
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/me", undefined, cookies(memberLogin))).status,
        200,
      );
      assert.ok(mailbox.messages.every((m) => m.kind === "invitation"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.cleanup(runtime.store);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
