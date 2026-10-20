import { useWorkspaceLocation } from "@/workspaces/location"
import { Persist, persisted } from "@/runtime/persistence/storage"
import type { SessionStatus, SessionStepFailed } from "@opencode/client/promise"
import { onCleanup } from "solid-js"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { useSessionLayout } from "./session-layout"
import { useDialog, useI18n } from "@opencode/ui/context"
import { DialogUsageExceeded } from "@/providers/connect/usage-exceeded"

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"

const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"

const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"

const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"

const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs

const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

const GO_URL = "https://opencode.ai/go"

const CHATGPT_USAGE_LIMIT_WINDOW = 86_400_000 // 24 hrs

export function isChatGPTUsageLimit(error: SessionStepFailed["data"]["error"]) {
  return (
    error.message ===
    "ChatGPT usage limit reached. Try again after your allowance resets; check ChatGPT Settings → Usage for details."
  )
}

export const GoUpsellState = Persistence.struct({
  [GO_UPSELL_FREE_TIER_LAST_SEEN_AT]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_FREE_TIER_DONT_SHOW]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT]: Schema.NullOr(Schema.Finite),
  [GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW]: Schema.NullOr(Schema.Finite),
})

function goUpsellKeys(status: SessionStatus) {
  if (status.type !== "retry" || !status.action) return
  const { action } = status

  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return

  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    } as const
  }
}

export function useUsageExceededDialogs() {
  const sdk = useWorkspaceLocation()
  const dialog = useDialog()
  const { params } = useSessionLayout()
  const { t, tDynamic, locale } = useI18n()

  const [goUpsellState, setGoUpsellState] = persisted(Persist.global("go-upsell"), GoUpsellState, {
    [GO_UPSELL_FREE_TIER_LAST_SEEN_AT]: null,
    [GO_UPSELL_FREE_TIER_DONT_SHOW]: null,
    [GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT]: null,
    [GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW]: null,
  })

  const [chatgptUsageLimit, setChatGPTUsageLimit] = persisted(
    Persist.global("chatgpt-usage-limit"),
    Persistence.struct({ lastSeenAt: Schema.NullOr(Schema.Finite) }),
    { lastSeenAt: null },
  )

  onCleanup(
    sdk().event.on("session.step.failed", (evt) => {
      if (evt.data.sessionID !== params.id || dialog.active) return
      const error = evt.data.error

      if (error.type === "provider.free-limit") {
        const seen = goUpsellState[GO_UPSELL_FREE_TIER_LAST_SEEN_AT]

        if (seen && Date.now() - seen < GO_UPSELL_WINDOW) return

        if (goUpsellState[GO_UPSELL_FREE_TIER_DONT_SHOW]) return

        // Counted when shown, so dismissing with Escape or the backdrop also waits out the window.
        setGoUpsellState(GO_UPSELL_FREE_TIER_LAST_SEEN_AT, Date.now())

        const reset =
          error.retryAfterMs === undefined
            ? undefined
            : new Intl.DateTimeFormat(locale(), { timeStyle: "short" }).format(Date.now() + error.retryAfterMs)

        dialog.show(() => (
          <DialogUsageExceeded
            title={t("dialog.usageExceeded.freeTier.title")}
            description={
              reset
                ? t("dialog.usageExceeded.freeTier.descriptionReset", { time: reset })
                : t("dialog.usageExceeded.freeTier.description")
            }
            actionLabel={t("dialog.usageExceeded.freeTier.actionLabel")}
            link={GO_URL}
            onClose={(dontShowAgain) => {
              if (dontShowAgain) setGoUpsellState(GO_UPSELL_FREE_TIER_DONT_SHOW, Date.now())
              else {
                void import("@/providers/connect/dialog").then((x) => {
                  const controller = x.useProviderConnectController()
                  controller.select("opencode-go")
                  void dialog.show(() => <x.DialogConnectProvider directory={sdk().directory} controller={controller} />)
                })
              }
            }}
          />
        ))

        return
      }

      if (!isChatGPTUsageLimit(error)) return

      if (chatgptUsageLimit.lastSeenAt && Date.now() - chatgptUsageLimit.lastSeenAt < CHATGPT_USAGE_LIMIT_WINDOW) return

      void import("@/providers/connect/chatgpt-usage-limit").then((usage) => {
        if (dialog.active) return
        setChatGPTUsageLimit("lastSeenAt", Date.now())
        dialog.show(() => <usage.DialogChatGPTUsageLimit />)
      })
    }),
  )

  onCleanup(
    sdk().event.on("session.status", (evt) => {
      if (evt.data.sessionID !== params.id) return

      if (evt.data.status.type !== "retry") return
      const { action } = evt.data.status

      if (!action) return

      if (dialog.active) return

      const keys = goUpsellKeys(evt.data.status)

      if (!keys) return

      const seen = goUpsellState[keys.lastSeenAt]

      if (seen && Date.now() - seen < GO_UPSELL_WINDOW) return

      if (goUpsellState[keys.dontShow]) return

      if (action.reason === "account_rate_limit") {
        dialog.show(() => (
          <DialogUsageExceeded
            title={tDynamic("dialog.usageExceeded.accountRateLimit.title", action.title)}
            description={tDynamic("dialog.usageExceeded.accountRateLimit.description", action.message)}
            actionLabel={tDynamic("dialog.usageExceeded.accountRateLimit.actionLabel", action.label)}
            link={action.link}
            onClose={(dontShowAgain) => {
              setGoUpsellState(keys.lastSeenAt, Date.now())

              if (dontShowAgain) setGoUpsellState(keys.dontShow, Date.now())
            }}
          />
        ))
      }
    }),
  )
}
