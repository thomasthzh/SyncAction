/* global URLSearchParams */

/**
 * @typedef {{
 *   username: string;
 *   password: string;
 *   totp?: string;
 * }} LoginCredentials
 * @typedef {{
 *   status?: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
 *   limit?: number;
 * }} UserFilters
 * @typedef {{
 *   lifecycle?: "ACTIVE" | "DELETED";
 *   quotaClass?: "ORDINARY" | "EXEMPT";
 *   limit?: number;
 * }} RoomFilters
 * @typedef {{
 *   method?: "GET" | "POST";
 *   body?: unknown;
 *   signal?: AbortSignal;
 * }} RequestOptions
 */

export class AdminApiError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string | undefined} requestId
   */
  constructor(code, status, requestId) {
    super(code);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * @param {typeof fetch} [fetchImplementation]
 */
export function createAdminApi(fetchImplementation = globalThis.fetch.bind(globalThis)) {
  /**
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async function request(path, options = {}) {
    /** @type {RequestInit} */
    const init = {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers = {
        accept: "application/json",
        "content-type": "application/json",
      };
    }
    const response = await fetchImplementation(path, init);
    if (response.status === 204) {
      return undefined;
    }
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      const errorPayload = isRecord(payload) ? payload : {};
      throw new AdminApiError(
        typeof errorPayload.code === "string" ? errorPayload.code : "ADMIN_REQUEST_FAILED",
        response.status,
        typeof errorPayload.requestId === "string" ? errorPayload.requestId : undefined,
      );
    }
    return payload;
  }

  return {
    /**
     * @param {LoginCredentials} credentials
     * @param {AbortSignal} [signal]
     */
    login(credentials, signal) {
      return request("/v1/admin/auth/login", {
        method: "POST",
        body: credentials,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /** @param {AbortSignal} [signal] */
    logout(signal) {
      return request("/v1/admin/auth/logout", {
        method: "POST",
        body: {},
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /** @param {AbortSignal} [signal] */
    me(signal) {
      return request("/v1/admin/me", signal === undefined ? {} : { signal });
    },
    /** @param {AbortSignal} [signal] */
    onboarding(signal) {
      return request("/v1/admin/onboarding", signal === undefined ? {} : { signal });
    },
    /** @param {AbortSignal} [signal] */
    totpEnrollment(signal) {
      return request("/v1/admin/onboarding/totp", signal === undefined ? {} : { signal });
    },
    /**
     * @param {{ newPassword?: string; totp: string }} input
     * @param {AbortSignal} [signal]
     */
    completeOnboarding(input, signal) {
      return request("/v1/admin/onboarding/complete", {
        method: "POST",
        body: input,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    bindLinkedUser(userId, signal) {
      return request("/v1/admin/me/linked-user", {
        method: "POST",
        body: { userId },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /** @param {AbortSignal} [signal] */
    listActivationGrants(signal) {
      return request("/v1/admin/account-activation-grants", signal === undefined ? {} : { signal });
    },
    /**
     * @param {string} note
     * @param {AbortSignal} [signal]
     */
    createActivationGrant(note, signal) {
      return request("/v1/admin/account-activation-grants", {
        method: "POST",
        body: { note },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {string} grantId
     * @param {AbortSignal} [signal]
     */
    revokeActivationGrant(grantId, signal) {
      return request(`/v1/admin/account-activation-grants/${encodeURIComponent(grantId)}/revoke`, {
        method: "POST",
        body: {},
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {UserFilters} [filters]
     * @param {AbortSignal} [signal]
     */
    listUsers(filters = {}, signal) {
      const query = new URLSearchParams();
      if (filters.status !== undefined) {
        query.set("status", filters.status);
      }
      query.set("limit", String(filters.limit ?? 200));
      return request(withQuery("/v1/admin/users", query), signal === undefined ? {} : { signal });
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    listUserDevices(userId, signal) {
      return request(
        `/v1/admin/users/${encodeURIComponent(userId)}/devices`,
        signal === undefined ? {} : { signal },
      );
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    approveUser(userId, signal) {
      return emptyMutation(`/v1/admin/users/${encodeURIComponent(userId)}/approve`, signal);
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    suspendUser(userId, signal) {
      return emptyMutation(`/v1/admin/users/${encodeURIComponent(userId)}/suspend`, signal);
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    revokeUser(userId, signal) {
      return emptyMutation(`/v1/admin/users/${encodeURIComponent(userId)}/revoke`, signal);
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    revokeAllSessions(userId, signal) {
      return emptyMutation(`/v1/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, signal);
    },
    /**
     * @param {string} userId
     * @param {string} deviceId
     * @param {AbortSignal} [signal]
     */
    revokeDevice(userId, deviceId, signal) {
      return emptyMutation(
        `/v1/admin/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
        signal,
      );
    },
    /**
     * @param {string} userId
     * @param {AbortSignal} [signal]
     */
    issuePasswordReset(userId, signal) {
      return emptyMutation(`/v1/admin/users/${encodeURIComponent(userId)}/password-reset`, signal);
    },
    /**
     * @param {RoomFilters} [filters]
     * @param {AbortSignal} [signal]
     */
    listRooms(filters = {}, signal) {
      const query = new URLSearchParams();
      if (filters.lifecycle !== undefined) {
        query.set("lifecycle", filters.lifecycle);
      }
      if (filters.quotaClass !== undefined) {
        query.set("quotaClass", filters.quotaClass);
      }
      query.set("limit", String(filters.limit ?? 200));
      return request(withQuery("/v1/admin/rooms", query), signal === undefined ? {} : { signal });
    },
    /**
     * @param {string} roomId
     * @param {AbortSignal} [signal]
     */
    listRoomMembers(roomId, signal) {
      return request(
        `/v1/admin/rooms/${encodeURIComponent(roomId)}/members`,
        signal === undefined ? {} : { signal },
      );
    },
    /**
     * @param {string} roomId
     * @param {string} reasonCode
     * @param {AbortSignal} [signal]
     */
    softDeleteRoom(roomId, reasonCode, signal) {
      return request(`/v1/admin/rooms/${encodeURIComponent(roomId)}/soft-delete`, {
        method: "POST",
        body: { reasonCode },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {string} roomId
     * @param {string} reasonCode
     * @param {AbortSignal} [signal]
     */
    restoreRoom(roomId, reasonCode, signal) {
      return request(`/v1/admin/rooms/${encodeURIComponent(roomId)}/restore`, {
        method: "POST",
        body: { reasonCode },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {string} roomId
     * @param {string} newOwnerUserId
     * @param {string} reasonCode
     * @param {AbortSignal} [signal]
     */
    transferOwnership(roomId, newOwnerUserId, reasonCode, signal) {
      return request(`/v1/admin/rooms/${encodeURIComponent(roomId)}/ownership-transfer`, {
        method: "POST",
        body: { newOwnerUserId, reasonCode },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    /**
     * @param {number} [limit]
     * @param {AbortSignal} [signal]
     */
    listAuditEvents(limit = 100, signal) {
      const query = new URLSearchParams({ limit: String(limit) });
      return request(
        withQuery("/v1/admin/audit-events", query),
        signal === undefined ? {} : { signal },
      );
    },
    /** @param {AbortSignal} [signal] */
    diagnostics(signal) {
      return request("/v1/admin/diagnostics", signal === undefined ? {} : { signal });
    },
  };

  /**
   * @param {string} path
   * @param {AbortSignal | undefined} signal
   */
  function emptyMutation(path, signal) {
    return request(path, {
      method: "POST",
      body: {},
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

/**
 * @param {string} path
 * @param {URLSearchParams} query
 */
function withQuery(path, query) {
  const serialized = query.toString();
  return serialized === "" ? path : `${path}?${serialized}`;
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readResponsePayload(response) {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminApiError("ADMIN_RESPONSE_INVALID", response.status, undefined);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
