const express = require("express");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Subscriber = require("../model/subscriber");
const Subscription = require("../model/subscription");
const StatusPage = require("../model/status_page");
const { checkLogin } = require("../util-server");

const router = express.Router();

// Enable CORS for public subscriber endpoints
router.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

/**
 * Subscribe to a status page
 * POST /api/status-page/:slug/subscribe
 * Public endpoint (no auth required)
 */
router.post("/api/status-page/:slug/subscribe", async (request, response) => {
    try {
        const { slug } = request.params;
        const { email, componentId, notifyIncidents, notifyMaintenance, notifyStatusChanges } = request.body;

        // Validate email
        if (!email || !email.includes("@")) {
            return response.status(400).json({
                ok: false,
                msg: "Valid email address is required",
            });
        }

        // Get status page
        const statusPageId = await StatusPage.slugToID(slug);
        if (!statusPageId) {
            return response.status(404).json({
                ok: false,
                msg: "Status page not found",
            });
        }

        // Find or create subscriber
        let subscriber = await Subscriber.findByEmail(email);
        
        if (!subscriber) {
            subscriber = R.dispense("subscriber");
            subscriber.email = email;
            subscriber.unsubscribe_token = Subscriber.generateUnsubscribeToken();
            await R.store(subscriber);
            
            log.info("subscriber", `New subscriber created: ${email}`);
        }

        // Check if subscription already exists
        const existingSub = await Subscription.exists(
            subscriber.id,
            statusPageId,
            componentId || null
        );

        if (existingSub) {
            return response.json({
                ok: true,
                msg: "Already subscribed. Check your email for verification if you haven't verified yet.",
                alreadySubscribed: true,
            });
        }

        // Create subscription with verification required
        const subscription = R.dispense("subscription");
        subscription.subscriber_id = subscriber.id;
        subscription.status_page_id = statusPageId;
        subscription.component_id = componentId || null;
        subscription.notify_incidents = notifyIncidents !== false;
        subscription.notify_maintenance = notifyMaintenance !== false;
        subscription.notify_status_changes = notifyStatusChanges || false;
        subscription.verified = false;
        subscription.verification_token = Subscription.generateVerificationToken();
        await R.store(subscription);

        log.info("subscriber", `New subscription created for ${email} to status page ${statusPageId}`);

        try {
            const NotificationSubscriber = require("../notification-subscriber");
            await NotificationSubscriber.sendSubscriptionConfirmation(subscriber, subscription, slug);
            log.info("subscriber", `Verification email queued for ${email}`);
        } catch (error) {
            log.error("subscriber", `Failed to queue verification email: ${error.message}`);
            // Don't fail the subscription creation if email fails
        }

        response.json({
            ok: true,
            msg: "Subscription created! Please check your email to verify your subscription.",
            needsVerification: true,
        });

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).json({
            ok: false,
            msg: error.message,
        });
    }
});

/**
 * Verify email subscription
 * GET /api/status-page/:slug/verify/:token
 * Public endpoint (no auth required)
 */
router.get("/api/status-page/:slug/verify/:token", async (request, response) => {
    try {
        const { token } = request.params;

        const subscription = await Subscription.findByVerificationToken(token);

        if (!subscription) {
            return response.status(404).send(`
                <html>
                    <head><title>Verification Failed</title></head>
                    <body style="font-family: Arial; text-align: center; padding: 50px;">
                        <h2>❌ Verification Failed</h2>
                        <p>This verification link is invalid or has expired.</p>
                    </body>
                </html>
            `);
        }

        await subscription.verify();

        const subscriber = await R.load("subscriber", subscription.subscriber_id);
        log.info("subscriber", `Subscription verified for: ${subscriber.email}`);

        response.send(`
            <html>
                <head><title>Email Verified</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>✅ Email Verified!</h2>
                    <p>Your email address has been verified successfully.</p>
                    <p>You will now receive status updates.</p>
                </body>
            </html>
        `);

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).send(`
            <html>
                <head><title>Error</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>⚠️ Error</h2>
                    <p>An error occurred during verification.</p>
                </body>
            </html>
        `);
    }
});

/**
 * Unsubscribe from all notifications
 * GET /api/status-page/:slug/unsubscribe/:token
 * Public endpoint (no auth required)
 */
router.get("/api/status-page/:slug/unsubscribe/:token", async (request, response) => {
    try {
        const { token } = request.params;

        const subscriber = await Subscriber.findByUnsubscribeToken(token);

        if (!subscriber) {
            return response.status(404).send(`
                <html>
                    <head><title>Unsubscribe Failed</title></head>
                    <body style="font-family: Arial; text-align: center; padding: 50px;">
                        <h2>❌ Unsubscribe Failed</h2>
                        <p>This unsubscribe link is invalid.</p>
                    </body>
                </html>
            `);
        }

        // Delete all subscriptions for this subscriber
        const subscriptions = await Subscription.getBySubscriber(subscriber.id);
        for (const subscription of subscriptions) {
            await R.trash(subscription);
        }

        log.info("subscriber", `Subscriber unsubscribed: ${subscriber.email}`);

        response.send(`
            <html>
                <head><title>Unsubscribed</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>✅ Unsubscribed</h2>
                    <p>You have been unsubscribed from all status updates.</p>
                    <p>We're sorry to see you go!</p>
                </body>
            </html>
        `);

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).send(`
            <html>
                <head><title>Error</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>⚠️ Error</h2>
                    <p>An error occurred while unsubscribing.</p>
                </body>
            </html>
        `);
    }
});

/**
 * Get subscriber count for a status page (public)
 * GET /api/status-page/:slug/subscriber-count
 */
router.get("/api/status-page/:slug/subscriber-count", async (request, response) => {
    try {
        const { slug } = request.params;

        const statusPageId = await StatusPage.slugToID(slug);
        if (!statusPageId) {
            return response.status(404).json({
                ok: false,
                msg: "Status page not found",
            });
        }

        const count = await R.count("subscription", " status_page_id = ? ", [statusPageId]);

        response.json({
            ok: true,
            count,
        });

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).json({
            ok: false,
            msg: error.message,
        });
    }
});

/**
 * Get all subscribers (admin only)
 * GET /api/subscribers
 */
router.get("/api/subscribers", async (request, response) => {
    try {
        // This would need authentication middleware
        // For now, we'll implement basic check
        checkLogin(request);

        const subscribers = await R.findAll("subscriber", " ORDER BY created_at DESC ");

        response.json({
            ok: true,
            subscribers: subscribers.map(s => s.toJSON()),
        });

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).json({
            ok: false,
            msg: error.message,
        });
    }
});

/**
 * Get subscriptions for a status page (admin only)
 * GET /api/status-page/:slug/subscriptions
 */
router.get("/api/status-page/:slug/subscriptions", async (request, response) => {
    try {
        checkLogin(request);

        const { slug } = request.params;
        const statusPageId = await StatusPage.slugToID(slug);
        
        if (!statusPageId) {
            return response.status(404).json({
                ok: false,
                msg: "Status page not found",
            });
        }

        const subscriptions = await R.find("subscription", 
            " status_page_id = ? ORDER BY created_at DESC ", 
            [statusPageId]
        );

        // Load subscriber details
        const result = [];
        for (const sub of subscriptions) {
            const subscriber = await R.load("subscriber", sub.subscriber_id);
            result.push({
                ...sub.toJSON(),
                subscriber: subscriber ? subscriber.toJSON() : null,
            });
        }

        response.json({
            ok: true,
            subscriptions: result,
        });

    } catch (error) {
        log.error("subscriber", error);
        response.status(500).json({
            ok: false,
            msg: error.message,
        });
    }
});

module.exports = router;
