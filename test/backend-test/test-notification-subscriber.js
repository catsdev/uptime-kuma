const { describe, test, mock, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const SubscriberNotificationService = require("../../server/notification-subscriber");

describe("SubscriberNotificationService", () => {
    describe("getDefaultNotification()", () => {
        test("returns notification marked as default", async () => {
            const mockNotification = { id: 1, config: '{"type":"smtp"}', is_default: true };
            mock.method(R, "findOne", () => mockNotification);
            
            const result = await SubscriberNotificationService.getDefaultNotification();
            
            assert.strictEqual(result, mockNotification);
        });

        test("falls back to first SMTP notification if no default", async () => {
            mock.method(R, "findOne", () => null);
            mock.method(R, "findAll", () => [
                { config: '{"type":"telegram"}' },
                { config: '{"type":"smtp"}' }
            ]);
            
            const result = await SubscriberNotificationService.getDefaultNotification();
            
            assert.strictEqual(JSON.parse(result.config).type, "smtp");
        });

        test("returns null if no SMTP notification found", async () => {
            mock.method(R, "findOne", () => null);
            mock.method(R, "findAll", () => [{ config: '{"type":"telegram"}' }]);
            
            const result = await SubscriberNotificationService.getDefaultNotification();
            
            assert.strictEqual(result, null);
        });

        test("returns null on error", async () => {
            mock.method(R, "findOne", () => {
                throw new Error("Database error");
            });
            
            const result = await SubscriberNotificationService.getDefaultNotification();
            
            assert.strictEqual(result, null);
        });
    });

    describe("queueNotification()", () => {
        test("creates notification queue entry", async () => {
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
            
            const result = await SubscriberNotificationService.queueNotification(1, "test_type", data);
            
            assert.strictEqual(result.subscriber_id, 1);
            assert.strictEqual(result.notification_type, "test_type");
            assert.strictEqual(result.status, "pending");
            assert.strictEqual(result.attempts, 0);
        });

        test("uses default subject if not provided", async () => {
            const queueBean = { subject: null };
            mock.method(R, "dispense", () => queueBean);
            mock.method(R, "isoDateTime", () => "2026-02-19T12:00:00Z");
            mock.method(R, "store", async (bean) => bean);
            
            await SubscriberNotificationService.queueNotification(1, "test", {});
            
            assert.strictEqual(queueBean.subject, "Status Page Notification");
        });
    });

    describe("sendIncidentNotification()", () => {
        test("skips unverified subscriptions", async () => {
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
            mock.method(require("../../server/model/subscription"), "getByStatusPage", () => mockSubscriptions);
            mock.method(SubscriberNotificationService, "queueNotification", async () => {});
            
            await SubscriberNotificationService.sendIncidentNotification(1);
            
            // Should only queue for verified subscription
            const queueCalls = SubscriberNotificationService.queueNotification.mock.calls;
            assert.strictEqual(queueCalls.length, 1);
        });

        test("skips if notify_incidents is false", async () => {
            const mockIncident = { id: 1, status_page_id: 1, style: "danger", title: "Test", content: "Content", created_date: "2026-02-19" };
            const mockStatusPage = { id: 1, slug: "test-page" };
            const mockSubscriptions = [
                { subscriber_id: 1, notify_incidents: false, verified: true }
            ];
            
            mock.method(R, "load", (table) => {
                if (table === "incident") return mockIncident;
                if (table === "status_page") return mockStatusPage;
            });
            mock.method(require("../../server/model/subscription"), "getByStatusPage", () => mockSubscriptions);
            mock.method(SubscriberNotificationService, "queueNotification", async () => {});
            
            await SubscriberNotificationService.sendIncidentNotification(1);
            
            const queueCalls = SubscriberNotificationService.queueNotification.mock.calls;
            assert.strictEqual(queueCalls.length, 0);
        });

        test("throws error if incident not found", async () => {
            mock.method(R, "load", () => null);
            
            await assert.rejects(
                () => SubscriberNotificationService.sendIncidentNotification(999),
                { message: "Incident not found" }
            );
        });

        test("throws error if status page not found", async () => {
            mock.method(R, "load", (table) => {
                if (table === "incident") return { id: 1, status_page_id: 1 };
                return null;
            });
            
            await assert.rejects(
                () => SubscriberNotificationService.sendIncidentNotification(1),
                { message: "Status page not found" }
            );
        });
    });

    describe("processQueue()", () => {
        test("processes pending notifications", async () => {
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
            
            await SubscriberNotificationService.processQueue();
            
            assert.strictEqual(mockItems[0].status, "sent");
        });

        test("marks invalid notifications as failed", async () => {
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
            
            await SubscriberNotificationService.processQueue();
            
            assert.strictEqual(mockItems[0].status, "failed");
            assert.strictEqual(mockItems[0].last_error, "Invalid message format");
        });

        test("increments attempts on error", async () => {
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
            
            await SubscriberNotificationService.processQueue();
            
            assert.strictEqual(mockItems[0].attempts, 1);
        });

        test("marks as failed after 5 attempts", async () => {
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
            
            await SubscriberNotificationService.processQueue();
            
            assert.strictEqual(mockItems[0].status, "failed");
            assert.strictEqual(mockItems[0].attempts, 5);
        });

        test("returns early if no pending notifications", async () => {
            mock.method(R, "find", () => []);
            const mockStore = mock.method(R, "store", () => {});
            
            await SubscriberNotificationService.processQueue();
            
            // Should not call store
            assert.strictEqual(mockStore.mock.calls.length, 0);
        });
    });

    describe("startQueueProcessor() and stopQueueProcessor()", () => {
        after(() => {
            // Ensure processor is stopped after tests
            if (SubscriberNotificationService.queueInterval) {
                clearInterval(SubscriberNotificationService.queueInterval);
                SubscriberNotificationService.queueInterval = null;
            }
        });
        
        test("starts and stops queue processor", () => {
            mock.method(SubscriberNotificationService, "processQueue", () => {});
            
            // Ensure not running
            if (SubscriberNotificationService.queueInterval) {
                clearInterval(SubscriberNotificationService.queueInterval);
                SubscriberNotificationService.queueInterval = null;
            }
            
            SubscriberNotificationService.startQueueProcessor();
            assert.ok(SubscriberNotificationService.queueInterval);
            
            SubscriberNotificationService.stopQueueProcessor();
            assert.strictEqual(SubscriberNotificationService.queueInterval, null);
        });
    });
});
