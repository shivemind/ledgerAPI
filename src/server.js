const crypto = require("node:crypto");
const http = require("node:http");

const {
  matchRoute,
  parseUrl,
  readJson,
  sendJson
} = require("./http");
const { extractOrCreateTraceparent } = require("./trace");

const serviceName = process.env.SERVICE_NAME || "ledger-api";
const port = Number(process.env.PORT || 8082);

const state = {
  entries: [
    {
      id: "entry-seed-001",
      accountId: "acct-checking-001",
      transferId: "tx-seed-001",
      amount: 75.5,
      currency: "USD",
      direction: "debit",
      type: "authorization_hold",
      reference: "seed-transfer",
      status: "posted",
      createdAt: "2026-04-07T00:00:00.000Z"
    }
  ]
};

function log(message, metadata = {}) {
  console.log(
    JSON.stringify({
      service: serviceName,
      message,
      ...metadata
    })
  );
}

function findEntry(entryId) {
  return state.entries.find((entry) => entry.id === entryId);
}

function validateEntryPayload(payload) {
  const requiredFields = ["accountId", "amount", "currency", "direction", "type"];
  const missingField = requiredFields.find((field) => payload[field] === undefined || payload[field] === "");

  if (missingField) {
    return `Missing required field: ${missingField}`;
  }

  if (!["debit", "credit"].includes(payload.direction)) {
    return "direction must be debit or credit";
  }

  if (Number(payload.amount) <= 0) {
    return "amount must be greater than 0";
  }

  return null;
}

const server = http.createServer(async (req, res) => {
  const traceparent = extractOrCreateTraceparent(req.headers);
  res.setHeader("traceparent", traceparent);

  try {
    const url = parseUrl(req);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: serviceName,
        projectId: process.env.POSTMAN_INSIGHTS_PROJECT_ID || "",
        workspaceId: process.env.POSTMAN_INSIGHTS_WORKSPACE_ID || "",
        systemEnv: process.env.POSTMAN_INSIGHTS_SYSTEM_ENV || ""
      });
      return;
    }

    if (req.method === "GET" && pathname === "/entries") {
      const transferId = url.searchParams.get("transferId");
      const accountId = url.searchParams.get("accountId");

      const filteredEntries = state.entries.filter((entry) => {
        if (transferId && entry.transferId !== transferId) {
          return false;
        }

        if (accountId && entry.accountId !== accountId) {
          return false;
        }

        return true;
      });

      sendJson(res, 200, {
        data: filteredEntries
      });
      return;
    }

    if (req.method === "POST" && pathname === "/entries") {
      const payload = await readJson(req);
      const validationError = validateEntryPayload(payload);

      if (validationError) {
        sendJson(res, 400, {
          error: "validation_error",
          message: validationError,
          statusCode: 400
        });
        return;
      }

      const entry = {
        id: `entry-${crypto.randomUUID()}`,
        accountId: payload.accountId,
        transferId: payload.transferId || "",
        amount: Number(payload.amount),
        currency: payload.currency,
        direction: payload.direction,
        type: payload.type,
        reference: payload.reference || "",
        status: "posted",
        createdAt: new Date().toISOString()
      };

      state.entries.unshift(entry);
      log("ledger_entry_posted", {
        traceparent,
        entryId: entry.id,
        transferId: entry.transferId
      });
      sendJson(res, 201, entry);
      return;
    }

    const entryMatch = matchRoute(pathname, "/entries/:entryId");
    if (entryMatch && req.method === "GET") {
      const entry = findEntry(entryMatch.entryId);

      if (!entry) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Entry ${entryMatch.entryId} was not found`,
          statusCode: 404
        });
        return;
      }

      sendJson(res, 200, entry);
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message: `No route for ${req.method} ${pathname}`,
      statusCode: 404
    });
  } catch (error) {
    log("request_failed", {
      traceparent,
      error: error.message
    });
    sendJson(res, 500, {
      error: "internal_error",
      message: error.message,
      statusCode: 500
    });
  }
});

server.listen(port, () => {
  log("service_started", {
    port
  });
});
