import { Timestamp } from 'firebase-admin/firestore';

export type PlatformActionStatus = 'pending_authorization' | 'in_progress' | 'completed' | 'failed';

export type PlatformActionCode =
  | 'issues.create'
  | 'issues.update'
  | 'issues.delete'
  | 'issues.reparent'
  | 'issues.duplicate'
  | 'projects.create'
  | 'projects.update'
  | 'projects.delete'
  | 'workspaces.create'
  | 'workspaces.inviteMember'
  | 'workspaces.update'
  | 'workspaces.getAgentBudget'
  | 'apikeys.create'
  | 'apikeys.revoke'
  | 'apikeys.list'
  | 'comments.create'
  | 'agents.create'
  | 'agents.update'
  | 'agents.list'
  | 'agents.connectRepo'
  | 'agents.disconnectRepo'
  | 'agents.getQaCalibration'
  | 'runners.register'
  | 'runners.issueJob'
  | 'runners.list'
  | 'runners.revoke'
  | 'runners.rotateCredential'
  | 'runners.listJobs'
  | 'runners.retryJob'
  | 'issues.claim'
  | 'issues.claimNext'
  | 'issues.release'
  | 'issues.requestRepoWork'
  | 'issues.reportPendingWork'
  | 'issues.assignExecutionAgent'
  | 'github.createInstallUrl'
  | 'github.status'
  | 'github.createBranch'
  | 'github.linkPr'
  | 'github.syncFromWebhook'
  | 'environments.create'
  | 'environments.list'
  | 'environments.update'
  | 'environments.verify'
  | 'environments.disconnect'
  | 'environments.connectRepo'
  | 'deployments.start'
  | 'deployments.report'
  | 'deployments.cancel'
  | 'salesforce.query'
  | 'salesforce.toolingQuery'
  | 'salesforce.describe'
  | 'salesforce.limits'
  | 'labels.create'
  | 'cycles.create'
  | 'cycles.update'
  | 'cycles.close'
  | 'cycles.updateSettings'
  | 'notifications.markRead'
  | 'notifications.markAllRead'
  | 'notifications.muteIssue'
  | 'notifications.snooze'
  | 'notifications.updatePreferences'
  | 'reviews.start'
  | 'reviews.submit'
  | 'reviews.override'
  | 'reviews.resolveFinding'
  | 'reviews.reportCriteria'
  | 'reviews.reportIncomplete'
  | 'reviews.dismissFinding'
  | 'reviews.rerun'
  | 'reviews.returnToAgent'
  | 'runs.complete';

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
