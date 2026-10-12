/** Shared official Channel app template for terminal and browser setup. */
export const feishuApplication = {
  appPreset: { name: "{user} 的 Agent", desc: "个人 Agent 的飞书对话与工具" },
  addons: {
    scopes: {
      tenant: [
        "im:message",
        "im:message:send_as_bot",
        "im:resource",
        "cardkit:card:write",
        "drive:drive",
      ],
    },
    events: {
      items: {
        tenant: [
          "im.message.receive_v1",
          "card.action.trigger",
          "im.message.reaction.created_v1",
          "im.message.reaction.deleted_v1",
          "drive.notice.comment_add_v1",
        ],
      },
    },
  },
};
