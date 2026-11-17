import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resend } from "resend";

import { createEmailService, resolveEmailDriver } from "./email.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

// Mailgun: what is posted, and that a 429 is tried again. Nothing here
// talks to Mailgun.
test("Mailgun gets the message as a form, and a 429 is tried again", async () => {
  const requests: { body: FormData; headers: HeadersInit; url: string }[] = [];
  const waits: number[] = [];
  const answers = [
    new Response("{}", { headers: { "retry-after": "2" }, status: 429 }),
    Response.json({ id: "<mg-1@example.test>", message: "Queued" }),
  ];
  const env = {
    MAILGUN_API_BASE: "https://api.eu.mailgun.net/",
    MAILGUN_API_KEY: "key-test",
    MAILGUN_DOMAIN: "Mail.Example.test",
  };

  assert.equal(resolveEmailDriver(env), "mailgun");
  assert.equal(
    resolveEmailDriver({ ...env, RESEND_API_KEY: "re_test" }),
    "resend",
  );

  const service = createEmailService({
    env,
    fetchImpl: (url, init) => {
      requests.push({
        body: init!.body as FormData,
        headers: init!.headers!,
        url: String(url),
      });
      return Promise.resolve(answers.shift()!);
    },
    resolveAddresses: () =>
      Promise.resolve({
        senderAddress: "Acme <sign@mail.example.test>",
        supportAddress: "help@example.test",
      }),
    wait: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });

  const result = await service.send({
    ...MESSAGE,
    attachments: [
      {
        content: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        filename: "signed.pdf",
      },
    ],
  });

  assert.equal(result.messageId, "<mg-1@example.test>");
  assert.deepEqual(waits, [2000]);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]!.url,
    "https://api.eu.mailgun.net/v3/mail.example.test/messages",
  );
  assert.deepEqual(requests[1]!.headers, {
    authorization: `Basic ${Buffer.from("api:key-test").toString("base64")}`,
  });
  const form = requests[1]!.body;
  assert.equal(form.get("from"), "Acme <sign@mail.example.test>");
  assert.equal(form.get("to"), MESSAGE.to);
  assert.equal(form.get("h:Reply-To"), "help@example.test");
  assert.equal(form.get("o:tag"), MESSAGE.template);
  assert.equal((form.get("attachment") as File).name, "signed.pdf");
});

test("a Mailgun error is raised with Mailgun's reason", async () => {
  const service = createEmailService({
    env: { MAILGUN_API_KEY: "key-test", MAILGUN_DOMAIN: "example.test" },
    fetchImpl: () =>
      Promise.resolve(Response.json({ message: "Forbidden" }, { status: 401 })),
    resolveAddresses: () =>
      Promise.resolve({
        senderAddress: "Acme <sign@example.test>",
        supportAddress: null,
      }),
  });

  await assert.rejects(
    service.send(MESSAGE),
    /Mailgun refused the email \(401\): Forbidden/,
  );
});
