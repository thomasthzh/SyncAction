import type { JSX } from "preact";
import { avatarForMember, type AvatarPaletteToken } from "../../ui/collaboration-view-model.js";
import { Icon } from "../icons.js";

export interface MemberClusterEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly online: boolean;
  readonly role?: "LEADER" | "FOLLOWER" | "OUTSIDE";
  readonly disabled?: boolean;
}

export interface MemberClusterProps {
  readonly members: readonly MemberClusterEntry[];
  readonly currentUserId: string | null;
  readonly playbackGroupId?: string;
  readonly onMemberClick: (member: MemberClusterEntry) => void;
}

export function MemberCluster({
  members,
  currentUserId,
  playbackGroupId,
  onMemberClick,
}: MemberClusterProps): JSX.Element {
  return (
    <div
      class={playbackGroupId === undefined ? "member-cluster" : "member-cluster is-following"}
      data-playback-group-id={playbackGroupId}
      aria-label={playbackGroupId === undefined ? "页面查看者" : "播放跟随组"}
    >
      {members.map((member) => {
        const avatar = avatarForMember(member.displayName, member.userId);
        return (
          <button
            class={`member-avatar ${avatar.paletteToken}`}
            type="button"
            key={member.userId}
            aria-label={`查看 ${member.displayName} 当前页面`}
            title={`${member.displayName}${member.role === "LEADER" ? " · 领播者" : ""}`}
            data-user-id={member.userId}
            data-current-user={member.userId === currentUserId ? "true" : "false"}
            data-online={member.online ? "true" : "false"}
            disabled={member.disabled === true}
            onClick={() => onMemberClick(member)}
          >
            <span aria-hidden="true">{avatar.initials}</span>
            {member.role === "LEADER" ? (
              <i class="leader-crown" aria-hidden="true">
                <Icon name="play" size={10} />
              </i>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function paletteClass(token: AvatarPaletteToken): string {
  return token;
}
