<template>
    <div class="subscriber-widget">
        <div v-if="!submitted" class="subscription-form">
            <h5 class="mb-3">
                <font-awesome-icon icon="envelope" class="me-2" />
                {{ $t("subscribeToUpdates") }}
            </h5>
            <p class="text-muted small">{{ $t("getNotifiedWhenIncidentsOccur") }}</p>

            <form @submit.prevent="subscribe">
                <div class="mb-3">
                    <input
                        v-model="email"
                        type="email"
                        class="form-control"
                        :placeholder="$t('yourEmailAddress')"
                        required
                    />
                </div>

                <!-- Notification Preferences -->
                <div class="mb-3">
                    <div class="form-check">
                        <input
                            id="notify-incidents"
                            v-model="preferences.notifyIncidents"
                            type="checkbox"
                            class="form-check-input"
                        />
                        <label for="notify-incidents" class="form-check-label">
                            {{ $t("incidentNotifications") }}
                        </label>
                    </div>
                    <div class="form-check">
                        <input
                            id="notify-status"
                            v-model="preferences.notifyStatusChanges"
                            type="checkbox"
                            class="form-check-input"
                        />
                        <label for="notify-status" class="form-check-label">
                            {{ $t("statusChangeNotifications") }}
                        </label>
                    </div>
                </div>

                <!-- Component Selection (Optional) -->
                <div v-if="components.length > 0 && showComponentSelect" class="mb-3">
                    <label class="form-label small">{{ $t("monitorSpecificComponents") }}</label>
                    <select v-model="selectedComponent" class="form-select form-select-sm">
                        <option value="">{{ $t("allComponents") }}</option>
                        <option v-for="component in components" :key="component.id" :value="component.id">
                            {{ component.name }}
                        </option>
                    </select>
                </div>

                <button
                    type="submit"
                    class="btn btn-primary w-100"
                    :disabled="subscribing || !preferences.notifyIncidents"
                >
                    <span v-if="subscribing" class="spinner-border spinner-border-sm me-2"></span>
                    {{ $t("subscribe") }}
                </button>

                <p class="text-muted small mt-2 mb-0">
                    {{ $t("wellSendYouVerificationEmail") }}
                </p>
            </form>

            <!-- Subscriber Count -->
            <div v-if="subscriberCount !== null" class="mt-3 text-center">
                <small class="text-muted">
                    <font-awesome-icon icon="users" />
                    {{ subscriberCount }} {{ $t("subscribers") }}
                </small>
            </div>
        </div>

        <!-- Success Message -->
        <div v-else class="subscription-success text-center py-4">
            <div class="success-icon mb-3">
                <font-awesome-icon icon="check-circle" size="3x" class="text-success" />
            </div>
            <h5>{{ $t("checkYourEmail") }}</h5>
            <p class="text-muted">
                {{ $t("verificationLinkSent") }} <strong>{{ email }}</strong>
            </p>
            <p class="small text-muted">
                {{ $t("clickTheLinkInEmailToConfirmSubscription") }}
            </p>
            <button class="btn btn-sm btn-outline-secondary mt-2" @click="reset">
                {{ $t("subscribeAnotherEmail") }}
            </button>
        </div>
    </div>
</template>

<script>
import axios from "axios";

export default {
    props: {
        statusPageSlug: {
            type: String,
            required: true,
        },
        components: {
            type: Array,
            default: () => [],
        },
        showComponentSelect: {
            type: Boolean,
            default: false,
        },
        compact: {
            type: Boolean,
            default: false,
        },
    },
    data() {
        return {
            email: "",
            selectedComponent: "",
            preferences: {
                notifyIncidents: true,
                notifyStatusChanges: false,
            },
            subscribing: false,
            submitted: false,
            subscriberCount: null,
        };
    },
    mounted() {
        this.loadSubscriberCount();
    },
    methods: {
        async loadSubscriberCount() {
            try {
                const response = await axios.get(`/api/status-page/${this.statusPageSlug}/subscriber-count`);
                if (response.data.ok) {
                    this.subscriberCount = response.data.count;
                }
            } catch (error) {
                console.error("Failed to load subscriber count:", error);
            }
        },

        async subscribe() {
            if (!this.email) {
                return;
            }

            this.subscribing = true;

            try {
                const response = await axios.post(`/api/status-page/${this.statusPageSlug}/subscribe`, {
                    email: this.email,
                    componentId: this.selectedComponent || null,
                    notifyIncidents: this.preferences.notifyIncidents,
                    notifyStatusChanges: this.preferences.notifyStatusChanges,
                });

                if (response.data.ok) {
                    this.submitted = true;
                    this.subscriberCount = (this.subscriberCount || 0) + 1;
                } else {
                    alert(response.data.msg || this.$t("failedToSubscribe"));
                }
            } catch (error) {
                console.error("Subscription error:", error);
                console.error("Error details:", error.response?.data || error.message);
                const errorMsg = error.response?.data?.msg || error.message || "An error occurred. Please try again.";
                alert(errorMsg);
            } finally {
                this.subscribing = false;
            }
        },

        reset() {
            this.email = "";
            this.selectedComponent = "";
            this.preferences = {
                notifyIncidents: true,
                notifyStatusChanges: false,
            };
            this.submitted = false;
        },
    },
};
</script>

<style scoped>
.subscriber-widget {
    background: white;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.subscription-form h5 {
    color: #212529;
    margin-bottom: 10px;
}

.form-check {
    padding-left: 1.5rem;
}

.form-check-label {
    font-size: 14px;
    cursor: pointer;
}

.success-icon {
    animation: scale-in 0.3s ease-out;
}

@keyframes scale-in {
    from {
        transform: scale(0);
    }

    to {
        transform: scale(1);
    }
}

.subscription-success {
    animation: fade-in 0.3s ease-in;
}

@keyframes fade-in {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}
</style>
