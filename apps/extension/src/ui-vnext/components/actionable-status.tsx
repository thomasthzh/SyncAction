const ERROR_LABELS: Readonly<Record<string, string>> = {
  ACCOUNT_PENDING: "账号仍在等待超级管理员批准",
  ACCOUNT_REVOKED: "账号已被撤销",
  ACCOUNT_SUSPENDED: "账号已暂停，请联系管理员",
  AUTHENTICATION_REQUIRED: "请先登录",
  INVALID_CREDENTIALS: "用户名或密码不正确",
  NETWORK_ERROR: "网络连接失败，请稍后重试",
  ROOM_CAPACITY_REACHED: "本服务器普通用户同时最多创建 5 个房间",
  ROOM_NOT_FOUND: "房间不存在或已关闭",
  ROOM_OWNER_REQUIRED: "只有房主可以执行此操作",
  INVALID_SERVER_URL: "服务器地址无效",
  PAGE_PERMISSION_DENIED: "未授予当前网站权限",
  PAGE_PERMISSION_AGREEMENT_REQUIRED: "请先阅读并同意页面协作说明",
  PAGE_PERMISSION_INTENT_STALE: "页面或服务器已变化，请重新发起授权",
  PAGE_CHANGED_DURING_PERMISSION: "授权期间页面已变化，本次新权限已撤回",
  PAGE_PERMISSION_UNAVAILABLE: "当前页面尚不能启用此协作能力",
  PAGE_PERMISSION_REQUEST_FAILED: "浏览器权限请求未完成",
  PAGE_CONSENT_PERSIST_FAILED: "授权记录未能安全保存，本次新权限已撤回",
  PAGE_PERMISSION_ACTIVATION_FAILED: "权限已保存，请稍后重试启用页面协作",
  AUTHORIZED_SITES_LOAD_FAILED: "已授权站点读取失败，请稍后重试",
  SERVER_HOST_PERMISSION_DENIED: "未授予此服务器的连接权限",
  SERVER_IDENTITY_CHANGED: "服务器身份已变化，已阻止连接",
  SERVER_VERIFICATION_FAILED: "服务器验证失败",
  SERVER_VERIFIER_UNAVAILABLE: "当前环境无法验证自定义服务器",
  UI_PORT_DISCONNECTED: "连接正在恢复，请稍后重试",
  USERNAME_TAKEN: "用户名已被占用",
  ACTIVATION_KEY_REQUIRED: "请输入账户密钥",
  ACTIVATION_KEY_FORMAT_INVALID:
    "密钥格式不正确：应以 sak_ 开头，后接 43 个英文字母、数字、- 或 _，并区分大小写",
  ACTIVATION_KEY_INVALID: "密钥不存在或输入错误，请核对管理员发送的完整密钥",
  ACTIVATION_KEY_EXPIRED: "账户密钥已过期，请联系管理员重新创建",
  ACTIVATION_KEY_USED: "此密钥对应的账户已完成设置，请使用用户名和密码登录",
  ACTIVATION_KEY_REVOKED: "账户密钥已被管理员撤销",
  CURRENT_PASSWORD_INVALID: "当前密码不正确",
  PASSWORD_CONFIRMATION_MISMATCH: "两次输入的新密码不一致",
  PASSWORD_ALREADY_CONFIGURED: "此账户已经设置登录密码，请使用当前密码进行修改",
  USERNAME_INVALID:
    "用户名必须为 3–32 位，仅可使用英文字母、数字及中间的 ._-，首尾必须是字母或数字",
  DISPLAY_NAME_INVALID: "显示名称不能为空或只包含空格，最多 64 个字符",
  PASSWORD_INVALID: "密码必须为 12–128 个字符",
  INVALID_INPUT: "提交内容格式无效，请按字段下方明文规则检查后重试",
};

export type StatusRecoveryAction =
  "ALLOW_PAGE" | "SWITCH_SERVER" | "UPGRADE_CLIENT" | "CONFIRM_RECOVERY" | "RETRY";

interface StatusDefinition {
  readonly text: string;
  readonly action: StatusRecoveryAction | null;
  readonly actionLabel: string | null;
}

const STATUS_DEFINITIONS: Readonly<Record<string, StatusDefinition>> = {
  LOADING: {
    text: "正在载入房间",
    action: null,
    actionLabel: null,
  },
  CONNECTING: {
    text: "正在连接房间",
    action: null,
    actionLabel: null,
  },
  RECONNECTING: {
    text: "连接正在恢复，已保留上次同步内容",
    action: null,
    actionLabel: null,
  },
  WAITING_SNAPSHOT: {
    text: "等待房间快照，页面内容仍可查看",
    action: null,
    actionLabel: null,
  },
  PAGE_PERMISSION_REQUIRED: {
    text: "当前网站尚未授权页面协作",
    action: "ALLOW_PAGE",
    actionLabel: "允许当前站点",
  },
  PROTECTED_PAGE: {
    text: "当前是浏览器保护页，扩展无法注入页面协作",
    action: null,
    actionLabel: null,
  },
  CONTENT_MISMATCH: {
    text: "页面内容与对方不同，已保护性暂停",
    action: null,
    actionLabel: null,
  },
  CONTENT_UNKNOWN: {
    text: "页面一致性尚未验证，位置协作已保护性暂停",
    action: null,
    actionLabel: null,
  },
  SERVER_UNSUPPORTED: {
    text: "当前服务器不支持此功能",
    action: "SWITCH_SERVER",
    actionLabel: "切换服务器",
  },
  CLIENT_UPGRADE_REQUIRED: {
    text: "客户端版本过旧，需升级后继续",
    action: "UPGRADE_CLIENT",
    actionLabel: "升级客户端",
  },
  ROOM_CAPACITY_REACHED: {
    text: "本服务器普通用户同时最多创建 5 个房间",
    action: null,
    actionLabel: null,
  },
  ROOM_TAB_LIMIT_REACHED: {
    text: "普通房间最多共享 20 个标签页",
    action: null,
    actionLabel: null,
  },
  RECOVERY_REQUIRED: {
    text: "浏览器状态与房间不一致，需要确认恢复",
    action: "CONFIRM_RECOVERY",
    actionLabel: "确认恢复",
  },
  CIRCUIT_BREAKER: {
    text: "同步已暂停以保护标签页，需要确认恢复",
    action: "CONFIRM_RECOVERY",
    actionLabel: "确认恢复",
  },
  NETWORK_ERROR: {
    text: "网络连接失败，本地状态已保留",
    action: "RETRY",
    actionLabel: "重试",
  },
};

export function errorLabel(errorCode: string): string {
  return ERROR_LABELS[errorCode] ?? `操作未完成（${errorCode}）`;
}

export interface ActionableStatusProps {
  readonly errorCode?: string | null;
  readonly statusCode?: string | null;
  readonly id?: string;
  readonly onAction?: (action: StatusRecoveryAction) => void;
}

export function ActionableStatus({
  errorCode = null,
  statusCode = null,
  id,
  onAction,
}: ActionableStatusProps): preact.JSX.Element | null {
  const definition = statusCode === null ? null : (STATUS_DEFINITIONS[statusCode] ?? null);
  if (errorCode === null && definition === null) {
    return null;
  }
  return (
    <div
      class={`inline-status ${errorCode === null ? "inline-status--info" : "inline-status--error"}`}
      id={id}
    >
      <span>{errorCode === null ? definition!.text : errorLabel(errorCode)}</span>
      {definition?.action !== null &&
      definition?.action !== undefined &&
      definition.actionLabel !== null &&
      onAction !== undefined ? (
        <button class="text-button" type="button" onClick={() => onAction(definition.action!)}>
          {definition.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
