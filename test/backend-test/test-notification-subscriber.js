const { describe, test, mock } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const SubscriberNotificationService = require("../../server/notification-subscriber");
const Subscription = require("../../server/model/subscription");
const { Settings } = require("../../server/settings");
const { Notification } = require("../../server/notification");

describe("SubscriberNotificationService", () => {
    describe("getDefaultNotification()", () => {
        test("returns notification marked as default", async () => {
            const mockNotification = { id: 1, config: '{"type":"smtp"}', is_default: true };
            mock.method(R, "findOne", () => mockNotification);

            try {
                const result = await SubscriberNotificationService.getDefaultNotification();
                assert.strictEqual(result, mockNotification);
            } finally {
                mock.restoreAll();
            }
        });

        test("falls back to first SMTP notification if no default", async () => {
            mock.method(R, "findOne", () => null);
            mock.method(R, "findAll", () => [
                { config: '{"type":"telegram"}' },
                { config: '{"type":"smtp"}' }
            ]);

            try {
                const result = await SubscriberNotificationService.getDefaultNotification();
                assert.strictEqual(JSON.parse(result.config).type, "smtp");
            } finally {
                mock.restoreAll();
            }
        });

        test("returns null if no SMTP notification found", async () => {
            mock.method(R, "findOne", () => null);
            mock.method(R, "findAll", () => [{ config: '{"type":"telegram"}' }]);

            try {
                const result = await SubscriberNotificationService.getDefaultNotification();
                assert.strictEqual(result, null);
            } finally {
                mock.restoreAll();
            }
        });

        test("returns null on database error", async () => {
            mock.method(R, "findOne", () => {
                throw new Error("Database error");
            });

            try {
                const result = await SubscriberNotificationService.getDefaultNotification();
                assert.strictEqual(result, null);
            } finally {
                mock.restoreAll();
            }
        });
    });

    describe("sendEmail()", () => {
        test("returns false when no default notification configured", async () => {
            mock.method(SubscriberNotificationService, "getDefaultNotification", async () => null);

            try {
                const result = await SubscriberNotificationService.sendEmail("test@example.com", "Subject", "<p>Body</p>");
                assert.strictEqual(result, false);
            } finally {
                mock.restoreAll();
            }
        });

        test("sends email via Notification.send when default notification exists", async () => {
            const mockNotification = {
                id: 1,
                config: JSON.stringify({ type: "smtp", name: "Test SMTP" })
            };
            mock.method(SubscriberNotificationService, "getDefaultNotification", async () => mockNotification);
            mock.method(Notification, "send", async () => {});

            try {
                const result = await SubscriberNotificationService.sendEmail("test@example.com", "Subject", "<p>Body</p>");
                assert.strictEqual(result, true);
                assert.strictEqual(Notification.send.mock.calls.length, 1);
            } finally {
                mock.restoreAll();
            }
        });

        test("throws error when Notification.send fails", async () => {
            const mockNotification = {
                id: 1,
                config: JSON.stringify({ type: "smtp", name: "Test SMTP" })
            };
            mock.method(SubscriberNotificationService, "getDefaultNotification", async () => mockNotification);
            mock.method(Notification, "send", async () => {
                throw new Error("SMTP connection failed");
            });

            try {
                await assert.rejects(
                    () => SubscriberNotificationService.sendEmail("test@example.com", "Subject", "<p>Body</p>"),
                    { message: "SMTP connection failed" }
                );
            } finally {
                mock.restoreAll();
            }
        });
    });

    describe("queueNotification()", () => {
        test("creates notification queue entry with correct fields", async () => {
            const queueBean = {
                subscriber_id: null,
                notification_type: null,
                subject: null,
                data: null,
                status: null,
                attempts: null,
                created_at: null
            };

            mock.method(R, "dispense", () => queueBean);
            mock.method(R, "isoDateTime", () => "2026-02-19T12:00:00Z");
            mock.method(R, "store", async (bean) => bean);

            const data = {
                message: {
                    to: "test@example.com",
                    subject: "Test Subject",
                    html: "<p>Test</p>"
                }
            };

            try {
                const result = await SubscriberNotificationService.queueNotification(1, "test_type", data);
                assert.strictEqual(result.subscriber_id, 1);
                assert.strictEqual(result.notification_type, "test_type");
                assert.strictEqual(result.status, "pending");
                assert.strictEqual(result.attempts, 0);
            } finally {
                mock.restoreAll();
            }
        });

        test("uses default subject if not provided", async () => {
            const queueBean = { subject: null };
            mock.method(R, "dispense", () => queueBean);
            mock.method(R, "isoDateTime", () => "2026-02-19T12:00:00Z");
            mock.method(R, "store", async (bean) => bean);

            try {
                await SubscriberNotificationService.queueNotification(1, "test", {});
                assert.strictEqual(queueBean.subject, "Status Page Notification");
            } finally {
                mock.restoreAll();
            }
        });
    });

    describe("sendIncidentNotification()", () => {
        test("skips queueing for unverified subscriptions", async () => {
            const mockIncident = { id: 1, status_page_id: 1, style: "danger", title: "Test", content: "Content", created_date: "2026-02-19" };
            const mockStatusPage = { id: 1, slug: "test-page" };
            const mockSubscriptions = [
                { subscriber_id: 1, notify_incidents: true, verified: false },
                { subscriber_id: 2, notify_incidents: true, verified: true }
            ];

            mock.method(R, "load", (table, id) => {
                if (table === "incident") return mockIncident;
                if (table === "status_page") return mockStatusPage;
                return { id, email: "test@example.com", unsubscribe_token: "token123" };
            });
            mock.method(Settings, "get", async () => "http://localhost:3000");
            mock.method(Subscription, "getByStatusPage", async () => mockSubscriptions);
            mock.method(SubscriberNotificationService, "queueNotification", async () => {});

            try {
                await SubscriberNotificationService.sendIncidentNotification(1);
                const queueCalls = SubscriberNotificationService.queueNotification.mock.calls;
                assert.strictEqual(queueCalls.length, 1);
            } finally {
                mock.restoreAll();
            }
        });

        test("skips queueing when notify_incidents is false", async () => {
            const mockIncident = { id: 1, status_page_id: 1, style: "danger", title: "Test", content: "Content", created_date: "2026-02-19" };
            const mockStatusPage = { id: 1, slug: "test-page" };
            const mockSubscriptions = [
                { subscriber_id: 1, notify_incidents: false, verified: true }
            ];

            mock.method(R, "load", (table) => {
                if (table === "incident") return mockIncident;
                if (table === "status_page") return mockStatusPage;
            });
            mock.method(Settings, "get", async () => "http://localhost:3000");
            mock.method(Subscription, "getByStatusPage", async () => mockSubscriptions);
            mock.method(SubscriberNotificationService, "queueNotification", async () => {});

            try {
                await SubscriberNotificationService.sendIncidentNotification(1);
                const queueCalls = SubscriberNotificationService.queueNotification.mock.calls;
                assert.strictEqual(queueCalls.length, 0);
            } finally {
                mock.restoreAll();
            }
        });

        test("throws error if incident not found", async () => {
            mock.method(R, "load", () => null);

            try {
                await assert.rejects(
                    () => SubscriberNotificationService.sendIncidentNotification(999),
                    { message: "Incident not found" }
                );
            } finally {
                mock.restoreAll();
            }
        });

        test("throws error if status page not found", async () => {
            mock.method(R, "load", (table) => {
                if (table === "incident") return { id: 1, status_page_id: 1 };
                return null;
            });

            try {
                await assert.rejects(
                    () => SubscriberNotificationService.sendIncidentNotification(1),
                    { message: "Status page not found" }
                );
            } finally {
                mock.restoreAll();
            }
        });
    });

    describe("processQueue()", () => {
        test("marks notification as sent on successful delivery", async () => {
            const mockItems = [
                {
                    id: 1,
                    data: JSON.stringify({
                        message: { to: "test@example.com", subject: "Test", html: "<p>Test</p>" }
                    }),
                    attempts: 0,
                    status: "pending"
                }
            ];

            mock.method(R, "find", () => mockItems);
            mock.method(R, "isoDateTime", () => "2026-02-19T12:00:00Z");
            mock.method(R, "store", async (item) => item);
            mock.method(SubscriberNotificationService, "sendEmail", async () => true);

            try {
                await SubscriberNotificationService.processQueue();
                assert.strictEqual(mockItems[0].status, "sent");
            } finally {
                mock.restoreAll();
            }
        });

        test("marks notification as failed for invalid message format", async () => {
            const mockItems = [
                {
                    id: 1,
                    data: JSON.stringify({ invalid: "data" }),
                    attempts: 0,
                    status: "pending"
                }
            ];

            mock.method(R, "find", () => mockItems);
            mock.method(R, "store", async (item) => item);

            try {
                await SubscriberNotificationService.processQueue();
                assert.strictEqual(mockItems[0].status, "failed");
                assert.strictEqual(mockItems[0].last_error, "Invalid message format");
            } finally {
                mock.restoreAll();
            }
        });

        test("increments attempts on delivery error", async () => {
            const mockItems = [
                {
                    id: 1,
                    data: JSON.stringify({
                        message: { to: "test@example.com", subject: "Test", html: "<p>Test</p>" }
                    }),
                    attempts: 0,
                    status: "pending"
                }
            ];

            mock.method(R, "find", () => mockItems);
            mock.method(R, "store", async (item) => item);
            mock.method(SubscriberNotificationService, "sendEmail", async () => {
                throw new Error("Send error");
            });

            try {
                await SubscriberNotificationService.processQueue();
                assert.strictEqual(mockItems[0].attempts, 1);
            } finally {
                mock.restoreAll();
            }
        });

        test("marks notification as failed after 5 attempts", async () => {
            const mockItems = [
                {
                    id: 1,
                    data: JSON.stringify({
                        message: { to: "test@example.com", subject: "Test", html: "<p>Test</p>" }
                    }),
                    attempts: 4,
                    status: "pending"
                }
            ];

            mock.method(R, "find", () => mockItems);
            mock.method(R, "store", async (item) => item);
            mock.method(SubscriberNotificationService, "sendEmail", async () => {
                throw new Error("Send error");
            });

            try {
                await SubscriberNotificationService.processQueue();
                assert.strictEqual(mockItems[0].status, "failed");
                assert.strictEqual(mockItems[0].attempts, 5);
            } finally {
                mock.restoreAll();
            }
        });

        test("returns early if no pending notifications", async () => {
            mock.method(R, "find", () => []);
            const mockStore = mock.method(R, "store", () => {});

            try {
                await SubscriberNotificationService.processQueue();
                assert.strictEqual(mockStore.mock.calls.length, 0);
            } finally {
                mock.restoreAll();
            }
        });
    });
});
