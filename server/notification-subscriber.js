const { R } = require("redbean-node");
const { log } = require("../src/util");
const { setting } = require("./util-server");
const Subscription = require("./model/subscription");
const { Notification } = require("./notification");

class SubscriberNotificationService {
    
    /**
     * Get default notification for status page emails
     * @returns {Promise<object|null>} notification bean or null
     */
    static async getDefaultNotification() {
        try {
            let notification = await R.findOne("notification", " is_default = ? ", [true]);
            
            if (!notification) {
                const allNotifications = await R.findAll("notification");
                for (const n of allNotifications) {
                    const config = JSON.parse(n.config);
                    if (config.type === "smtp") {
                        notification = n;
                        break;
                    }
                }
            }
            
            return notification;
        } catch (error) {
            log.error("notification", `Failed to get default notification: ${error.message}`);
            return null;
        }
    }

    /**
     * Send email using default notification
     * @param {string} to Recipient email address
     * @param {string} subject Email subject
     * @param {string} html HTML email content
     * @returns {Promise<boolean>} true if sent successfully
     */
    static async sendEmail(to, subject, html) {
        const notificationBean = await this.getDefaultNotification();
        
        if (!notificationBean) {
            log.warn("notification", "No default notification configured for status page emails");
            log.warn("notification", "Set up an SMTP notification and mark it as default in Settings > Notifications");
            return false;
        }

        try {
            const config = JSON.parse(notificationBean.config);
            
            const notification = {
                ...config,
                smtpTo: to,
                customSubject: subject,
                customBody: html,
                htmlBody: true,
            };
            
            await Notification.send(notification, "Status Page Notification Testing");
            
            log.info("notification", `Email sent to ${to} via "${config.name}"`);
            return true;
        } catch (error) {
            log.error("notification", `Failed to send email to ${to}: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Queue notification for later delivery
     * @param {number} subscriberId Subscriber ID
     * @param {string} type Notification type
     * @param {object} data Notification data
     * @returns {Promise<object>} queued notification bean
     */
    static async queueNotification(subscriberId, type, data) {
        try {
            const queue = R.dispense("notification_queue");
            queue.subscriber_id = subscriberId;
            queue.notification_type = type;
            queue.subject = data.message?.subject || "Status Page Notification";
            queue.data = JSON.stringify(data);
            queue.status = "pending";
            queue.attempts = 0;
            queue.created_at = R.isoDateTime();
            await R.store(queue);
            
            log.info("notification", `Queued ${type} for subscriber ${subscriberId}`);
            return queue;
        } catch (error) {
            log.error("notification", `Failed to queue notification: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send subscription confirmation email
     * @param {object} subscriber Subscriber object
     * @param {object} subscription Subscription object
     * @param {string} statusPageSlug Status page slug
     * @returns {Promise<void>}
     */
    static async sendSubscriptionConfirmation(subscriber, subscription, statusPageSlug) {
        try {
            const baseURL = await setting("primaryBaseURL");
            if (!baseURL) {
                throw new Error("Primary Base URL is not set. Please configure it in Settings > General.");
            }
            
            const verifyUrl = `${baseURL}/api/status-page/${statusPageSlug}/verify/${subscription.verification_token}`;
            const unsubscribeUrl = `${baseURL}/api/status-page/${statusPageSlug}/unsubscribe/${subscriber.unsubscribe_token}`;

            const message = {
                to: subscriber.email,
                subject: "Confirm your subscription",
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>Confirm Your Subscription</h2>
                        <p>Thank you for subscribing to status updates!</p>
                        <p>Please click the button below to verify your email address:</p>
                        <p style="text-align: center; margin: 30px 0;">
                            <a href="${verifyUrl}" 
                               style="background-color: #5cb85c; color: white; padding: 12px 24px; 
                                      text-decoration: none; border-radius: 4px; display: inline-block;">
                                Verify Email Address
                            </a>
                        </p>
                        <p style="color: #666; font-size: 12px;">
                            If the button doesn't work, copy and paste this link into your browser:<br>
                            <a href="${verifyUrl}">${verifyUrl}</a>
                        </p>
                        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                        <p style="color: #999; font-size: 11px;">
                            To unsubscribe from these notifications, click 
                            <a href="${unsubscribeUrl}">here</a>.
                        </p>
                    </div>
                `,
            };

            // Queue the notification instead of sending immediately
            await this.queueNotification(subscriber.id, "subscription_confirmation", {
                statusPageSlug,
                message,
            });

            log.info("notification", `Queued subscription confirmation for ${subscriber.email}`);
        } catch (error) {
            log.error("notification", `Failed to send subscription confirmation: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send incident notification to subscribers
     * @param {number} incidentId Incident ID
     * @returns {Promise<void>}
     */
    static async sendIncidentNotification(incidentId) {
        try {
            const incident = await R.load("incident", incidentId);
            if (!incident || !incident.id) {
                throw new Error("Incident not found");
            }

            // Load status page to get slug
            const statusPage = await R.load("status_page", incident.status_page_id);
            if (!statusPage || !statusPage.slug) {
                throw new Error("Status page not found");
            }

            const baseURL = await setting("primaryBaseURL");
            if (!baseURL) {
                log.warn("notification", "Primary Base URL is not set. Skipping incident notifications.");
                return;
            }

            // Get all subscriptions for this status page
            const subscriptions = await Subscription.getByStatusPage(incident.status_page_id);
            
            log.info("notification", `Sending incident notification to ${subscriptions.length} subscribers`);

            let queuedCount = 0;
            for (const subscription of subscriptions) {
                if (!subscription.notify_incidents) {
                    continue;
                }

                if (!subscription.verified) {
                    continue;
                }

                const subscriber = await R.load("subscriber", subscription.subscriber_id);

                const unsubscribeUrl = `${baseURL}/api/status-page/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`;

                const styleEmoji = {
                    danger: "🔴",
                    warning: "🟠",
                    info: "🔵",
                    primary: "ℹ️",
                    dark: "⚫",
                }[incident.style] || "📢";

                const message = {
                    to: subscriber.email,
                    subject: `[INCIDENT] ${incident.title}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>${styleEmoji} ${incident.title}</h2>
                            ${incident.content ? `<div style="margin: 20px 0;">${incident.content}</div>` : ""}
                            <p style="color: #666; font-size: 14px;"><strong>Posted:</strong> ${new Date(incident.created_date).toLocaleString()}</p>
                            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                            <p style="color: #999; font-size: 11px;">
                                To unsubscribe from these notifications, click 
                                <a href="${unsubscribeUrl}">here</a>.
                            </p>
                        </div>
                    `,
                };

                await this.queueNotification(subscriber.id, "incident_created", {
                    incidentId,
                    message,
                });
                queuedCount++;
            }

            log.info("notification", `Queued incident notifications for ${queuedCount} verified subscribers`);

        } catch (error) {
            log.error("notification", `Failed to send incident notification: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send incident update notification
     * @param {number} incidentId Incident ID
     * @param {string} updateMessage Update message
     * @returns {Promise<void>}
     */
    static async sendIncidentUpdateNotification(incidentId, updateMessage) {
        try {
            const incident = await R.load("incident", incidentId);
            if (!incident || !incident.id) {
                throw new Error("Incident not found");
            }

            // Load status page to get slug
            const statusPage = await R.load("status_page", incident.status_page_id);
            if (!statusPage || !statusPage.slug) {
                throw new Error("Status page not found");
            }

            const baseURL = await setting("primaryBaseURL");
            if (!baseURL) {
                log.warn("notification", "Primary Base URL is not set. Skipping incident update notifications.");
                return;
            }

            const subscriptions = await Subscription.getByStatusPage(incident.status_page_id);
            
            log.info("notification", `Sending incident update to ${subscriptions.length} subscribers`);

            for (const subscription of subscriptions) {
                if (!subscription.notify_incidents) {
                    continue;
                }

                if (!subscription.verified) {
                    continue;
                }

                const subscriber = await R.load("subscriber", subscription.subscriber_id);

                const unsubscribeUrl = `${baseURL}/api/status-page/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`;

                const message = {
                    to: subscriber.email,
                    subject: `[UPDATE] ${incident.title}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>Incident Update</h2>
                            <h3>${incident.title}</h3>
                            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; margin: 20px 0;">
                                ${updateMessage}
                            </div>
                            <p style="color: #666; font-size: 14px;"><strong>Last Updated:</strong> ${new Date(incident.last_updated_date || incident.created_date).toLocaleString()}</p>
                            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                            <p style="color: #999; font-size: 11px;">
                                To unsubscribe from these notifications, click 
                                <a href="${unsubscribeUrl}">here</a>.
                            </p>
                        </div>
                    `,
                };

                await this.queueNotification(subscriber.id, "incident_update", {
                    incidentId,
                    updateMessage,
                    message,
                });
            }

        } catch (error) {
            log.error("notification", `Failed to send incident update: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send incident resolved notification
     * @param {number} incidentId Incident ID
     * @returns {Promise<void>}
     */
    static async sendIncidentResolvedNotification(incidentId) {
        try {
            const incident = await R.load("incident", incidentId);
            if (!incident || !incident.id) {
                throw new Error("Incident not found");
            }

            // Load status page to get slug
            const statusPage = await R.load("status_page", incident.status_page_id);
            if (!statusPage || !statusPage.slug) {
                throw new Error("Status page not found");
            }

            const baseURL = await setting("primaryBaseURL");
            if (!baseURL) {
                log.warn("notification", "Primary Base URL is not set. Skipping incident resolved notifications.");
                return;
            }

            const subscriptions = await Subscription.getByStatusPage(incident.status_page_id);
            
            log.info("notification", `Sending incident resolved notification to ${subscriptions.length} subscribers`);

            for (const subscription of subscriptions) {
                if (!subscription.notify_incidents) {
                    continue;
                }

                if (!subscription.verified) {
                    continue;
                }

                const subscriber = await R.load("subscriber", subscription.subscriber_id);

                const unsubscribeUrl = `${baseURL}/api/status-page/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`;

                const message = {
                    to: subscriber.email,
                    subject: `[RESOLVED] ${incident.title}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2 style="color: #5cb85c;">✅ Incident Resolved</h2>
                            <h3>${incident.title}</h3>
                            <p><strong>Posted:</strong> ${new Date(incident.created_date).toLocaleString()}</p>
                            <p>This incident has been resolved. All systems are now operational.</p>
                            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                            <p style="color: #999; font-size: 11px;">
                                To unsubscribe from these notifications, click 
                                <a href="${unsubscribeUrl}">here</a>.
                            </p>
                        </div>
                    `,
                };

                await this.queueNotification(subscriber.id, "incident_resolved", {
                    incidentId,
                    message,
                });
            }

        } catch (error) {
            log.error("notification", `Failed to send incident resolved notification: ${error.message}`);
            throw error;
        }
    }

    /**
     * Send status change notification to subscribers
     * @param {number} monitorId Monitor ID
     * @param {string} monitorName Monitor name
     * @param {number} statusPageId Status page ID
     * @param {number} previousStatus Previous monitor status
     * @param {number} currentStatus Current monitor status
     * @returns {Promise<void>}
     */
    static async sendStatusChangeNotification(monitorId, monitorName, statusPageId, previousStatus, currentStatus) {
        try {
            const statusNames = {
                0: "Down",
                1: "Up",
                2: "Pending",
                3: "Maintenance"
            };

            const statusColors = {
                0: "#dc3545", // red
                1: "#28a745", // green
                2: "#ffc107", // yellow
                3: "#17a2b8"  // blue
            };

            const previousStatusName = statusNames[previousStatus] || "Unknown";
            const currentStatusName = statusNames[currentStatus] || "Unknown";

            // Load status page to get slug
            const statusPage = await R.load("status_page", statusPageId);
            if (!statusPage || !statusPage.slug) {
                throw new Error("Status page not found");
            }

            const baseURL = await setting("primaryBaseURL");
            if (!baseURL) {
                log.warn("notification", "Primary Base URL is not set. Skipping status change notifications.");
                return;
            }

            // Get subscriptions for this status page with notify_status_changes enabled
            const subscriptions = await R.getAll(
                `SELECT s.*, sub.email 
                 FROM subscription s 
                 INNER JOIN subscriber sub ON s.subscriber_id = sub.id 
                 WHERE s.status_page_id = ? 
                 AND s.notify_status_changes = 1 
                 AND s.verified = 1`,
                [statusPageId]
            );

            if (subscriptions.length === 0) {
                log.debug("notification", `No subscribers for status changes on page ${statusPageId}`);
                return;
            }

            log.info("notification", `Sending status change notification to ${subscriptions.length} subscribers for monitor ${monitorName}`);

            for (const subscription of subscriptions) {
                // Get subscriber with unsubscribe token
                const subscriber = await R.load("subscriber", subscription.subscriber_id);
                const unsubscribeUrl = `${baseURL}/api/status-page/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`;

                const message = {
                    to: subscription.email,
                    subject: `Status Change: ${monitorName} is now ${currentStatusName}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2 style="color: ${statusColors[currentStatus]};">Status Change Alert</h2>
                            <p><strong>${monitorName}</strong> has changed status:</p>
                            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                                <p style="margin: 5px 0;">
                                    <span style="color: ${statusColors[previousStatus]};">● ${previousStatusName}</span>
                                    → 
                                    <span style="color: ${statusColors[currentStatus]};">● ${currentStatusName}</span>
                                </p>
                            </div>
                            <p style="color: #666; font-size: 14px;">
                                You are receiving this notification because you subscribed to status change alerts.
                            </p>
                            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
                            <p style="color: #999; font-size: 11px;">
                                To unsubscribe from these notifications, click 
                                <a href="${unsubscribeUrl}">here</a>.
                            </p>
                        </div>
                    `,
                };

                await this.queueNotification(subscription.subscriber_id, "status_change", {
                    monitorId,
                    monitorName,
                    previousStatus: previousStatusName,
                    currentStatus: currentStatusName,
                    message,
                });
            }

            log.info("notification", `Queued status change notifications for monitor ${monitorName}`);
            
        } catch (error) {
            log.error("notification", `Failed to send status change notification: ${error.message}`);
            throw error;
        }
    }

    /**
     * Process notification queue
     * @returns {Promise<void>}
     */
    static async processQueue() {
        try {
            const pending = await R.find("notification_queue", 
                " status = ? AND attempts < ? ORDER BY created_at ASC LIMIT 50 ", 
                ["pending", 5]
            );

            if (pending.length === 0) {
                return;
            }

            log.info("notification", `Processing ${pending.length} queued notifications`);

            for (const item of pending) {
                try {
                    const data = JSON.parse(item.data);
                    
                    if (data.message && data.message.to && data.message.subject && data.message.html) {
                        const sent = await this.sendEmail(
                            data.message.to,
                            data.message.subject,
                            data.message.html
                        );
                        
                        if (sent) {
                            item.status = "sent";
                            item.sent_at = R.isoDateTime();
                        } else {
                            log.warn("notification", "SMTP not configured, marking as sent");
                            item.status = "sent";
                            item.sent_at = R.isoDateTime();
                        }
                    } else {
                        item.status = "failed";
                        item.last_error = "Invalid message format";
                    }
                    
                    await R.store(item);
                    
                } catch (error) {
                    log.error("notification", `Failed to process notification ${item.id}: ${error.message}`);
                    
                    item.attempts += 1;
                    item.last_error = error.message;
                    
                    if (item.attempts >= 5) {
                        item.status = "failed";
                    }
                    
                    await R.store(item);
                }
            }

        } catch (error) {
            log.error("notification", `Failed to process queue: ${error.message}`);
        }
    }

    /**
     * Start queue processor
     * @returns {void}
     */
    static startQueueProcessor() {
        log.info("notification", "Starting notification queue processor");
        
        this.processQueue();
        
        this.queueInterval = setInterval(() => {
            this.processQueue();
        }, 60000);
    }

    /**
     * Stop queue processor
     * @returns {void}
     */
    static stopQueueProcessor() {
        if (this.queueInterval) {
            clearInterval(this.queueInterval);
            this.queueInterval = null;
            log.info("notification", "Stopped notification queue processor");
        }
    }
}

module.exports = SubscriberNotificationService;
