import { Timestamp } from 'firebase-admin/firestore';

export type PlatformActionStatus = 'pending_authorization' | 'in_progress' | 'completed' | 'failed';

export type PlatformActionCode =
  | 'issues.create'
  | 'issues.update'
  | 'issues.delete'
  | 'projects.create'
  | 'projects.update'
  | 'projects.delete'
  | 'workspaces.create'
  | 'workspaces.inviteMember';

export interface PlatformActionCaller {
  readonly uid?: string;
  readonly email?: string;
  readonly isFromSystem: boolean;
}

export interface PlatformAction {
  readonly actionID: string;
  readonly actionCode: PlatformActionCode;
  readonly caller: PlatformActionCaller;
  readonly createdTime: Timestamp;
  readonly data: Record<string, any>;
  readonly status: PlatformActionStatus;
  completedTime?: Timestamp;
  failedTime?: Timestamp;
  failedReason?: string;
  response?: Record<string, any>;
}

export interface PlatformActionRequest {
  readonly actionCode: PlatformActionCode;
  readonly data: Record<string, any>;
  readonly actionID?: string;
  readonly force?: boolean;
}

export interface PlatformActionResponse {
  readonly success: boolean;
  readonly data?: Record<string, any>;
  readonly isReexecution?: boolean;
  readonly error?: string;
}
