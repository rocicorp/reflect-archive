import type {Immutable} from 'shared/src/immutable';
import type {Zero} from 'zero-client';
import {z} from 'zod';
import type {Collections} from './app';

export type M = Record<string, never>;

export const enum Priority {
  None = 1,
  Low,
  Medium,
  High,
  Urgent,
}

export const prioritySchema = z.union([
  z.literal(Priority.None),
  z.literal(Priority.Low),
  z.literal(Priority.Medium),
  z.literal(Priority.High),
  z.literal(Priority.Urgent),
]);

export enum PriorityString {
  None = 'NONE',
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
  Urgent = 'URGENT',
}

const labelColors = [
  '#483D8B', // Dark Slate Blue
  '#191970', // Midnight Blue
  '#36454F', // Charcoal
  '#556B2F', // Dark Olive Green
  '#4B0082', // Indigo
  '#333333', // Dark Charcoal
  '#2F4F4F', // Dark Slate Gray
  '#0C1021', // Onyx
];

export function getLabelColor(labelName: string) {
  const charCode = labelName.charCodeAt(2) || labelName.charCodeAt(0);
  return labelColors[charCode % labelColors.length];
}

export const priorityEnumSchema = z
  .nativeEnum(PriorityString)
  .transform(priorityFromString);

export function priorityFromString(priority: string): Priority {
  switch (priority) {
    case PriorityString.None:
      return Priority.None;
    case PriorityString.Low:
      return Priority.Low;
    case PriorityString.Medium:
      return Priority.Medium;
    case PriorityString.High:
      return Priority.High;
    case PriorityString.Urgent:
      return Priority.Urgent;
  }
  throw new Error('Invalid priority');
}

export function priorityToPriorityString(priority: Priority): PriorityString {
  switch (priority) {
    case Priority.None:
      return PriorityString.None;
    case Priority.Low:
      return PriorityString.Low;
    case Priority.Medium:
      return PriorityString.Medium;
    case Priority.High:
      return PriorityString.High;
    case Priority.Urgent:
      return PriorityString.Urgent;
  }
}

export enum StatusString {
  Backlog = 'BACKLOG',
  Todo = 'TODO',
  InProgress = 'IN_PROGRESS',
  Done = 'DONE',
  Canceled = 'CANCELED',
}

export const statusStringSchema = z
  .nativeEnum(StatusString)
  .transform(statusFromString);

export const enum Status {
  Backlog = 1,
  Todo,
  InProgress,
  Done,
  Canceled,
}

export const statusSchema = z.union([
  z.literal(Status.Backlog),
  z.literal(Status.Todo),
  z.literal(Status.InProgress),
  z.literal(Status.Done),
  z.literal(Status.Canceled),
]);

export function statusToStatusString(status: Status): StatusString {
  switch (status) {
    case Status.Backlog:
      return StatusString.Backlog;
    case Status.Todo:
      return StatusString.Todo;
    case Status.InProgress:
      return StatusString.InProgress;
    case Status.Done:
      return StatusString.Done;
    case Status.Canceled:
      return StatusString.Canceled;
  }
}

export function statusFromString(status: string): Status {
  switch (status) {
    case StatusString.Backlog:
      return Status.Backlog;
    case StatusString.Todo:
      return Status.Todo;
    case StatusString.InProgress:
      return Status.InProgress;
    case StatusString.Done:
      return Status.Done;
    case StatusString.Canceled:
      return Status.Canceled;
  }
  throw new Error('Invalid status');
}

export enum Order {
  Created = 'CREATED',
  Modified = 'MODIFIED',
  Status = 'STATUS',
  Priority = 'PRIORITY',
  Kanban = 'KANBAN',
}

export const orderEnumSchema = z.nativeEnum(Order);
export type OrderEnum = z.infer<typeof orderEnumSchema>;

export enum Filter {
  Priority,
  Status,
  Label,
}

const filterEnumSchema = z.nativeEnum(Filter);
export type FilterEnum = z.infer<typeof filterEnumSchema>;

export const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: prioritySchema,
  status: statusSchema,
  modified: z.number(),
  created: z.number(),
  creatorID: z.string(),
  kanbanOrder: z.string(),
  description: z.string(),
});

export type Issue = Immutable<z.TypeOf<typeof issueSchema>>;
export type IssueUpdate = Omit<Partial<Issue>, 'modified'> & {id: string};
export type Label = {id: string; name: string};
export type IssueLabel = {id: string; issueID: string; labelID: string};
export type IssueWithLabels = {issue: Issue; labels: string[]};

export const commentSchema = z.object({
  id: z.string(),
  issueID: z.string(),
  created: z.number(),
  body: z.string(),
  creatorID: z.string(),
});

export type Comment = Immutable<z.TypeOf<typeof commentSchema>>;

export async function putIssueComment(
  zero: Zero<Collections>,
  comment: Comment,
): Promise<void> {
  // TODO: All the mutators should be synchronous. We don't have
  // transactions now.
  await zero.mutate.comment.set(comment);

  // TODO: I think it would be more "real" to not have this denormalized
  // lastModified date. Instead, if the UI wants to show when the issue was
  // last modified it should select max() of comment last-modified.
  //
  // TODO: How would server-authoritative last-modifies work? It would be cool
  // to have some notion of "touch" in the CRUD API. Or maybe it would be
  // possible to setup the pg schema to ignore the incoming writes?
  await zero.mutate.issue.update({
    id: comment.issueID,
    modified: Date.now(),
  });
}

export async function deleteIssueComment(
  zero: Zero<Collections>,
  comment: Comment,
): Promise<void> {
  // TODO: We need a batch API in the client so that these two happen
  // synchronously.

  // TODO: Why is the delete param "any" not "string"?
  await zero.mutate.comment.delete(comment.id);
  await zero.mutate.issue.update({
    id: comment.issueID,
    modified: Date.now(),
  });
}

export async function updateIssues(
  zero: Zero<Collections>,
  {issueUpdates}: {issueUpdates: IssueUpdate[]},
) {
  const modified = Date.now();
  for (const issueUpdate of issueUpdates) {
    await zero.mutate.issue.update({
      ...issueUpdate,
      modified,
    });
  }
}

export const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const REVERSE_TIMESTAMP_LENGTH = Number.MAX_SAFE_INTEGER.toString().length;

export function reverseTimestampSortKey(timestamp: number, id: string): string {
  return (
    Math.floor(Number.MAX_SAFE_INTEGER - timestamp)
      .toString()
      .padStart(REVERSE_TIMESTAMP_LENGTH, '0') +
    '-' +
    id
  );
}
