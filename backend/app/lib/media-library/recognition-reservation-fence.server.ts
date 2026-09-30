import { createHash, randomUUID } from "node:crypto";
import { type Db, ObjectId } from "mongodb";

const RESERVATIONS = "media_recognition_asset_reservations";

export type MediaDeletionReservationTarget =
  | "previews"
  | "analysis"
  | "source_reference"
  | "asset_record"
  | "managed_original";

function objectId(value: ObjectId | string): ObjectId {
  return value instanceof ObjectId ? value : new ObjectId(value);
}

export function mediaRecognitionAssetReservationId(
  owner: string,
  assetIdValue: ObjectId | string,
): ObjectId {
  const assetId = objectId(assetIdValue);
  return new ObjectId(
    createHash("sha256").update(
      ["media-recognition-asset-reservation-v1", owner, String(assetId)].join(
        "\0",
      ),
    ).digest("hex").slice(0, 24),
  );
}

export class MediaRecognitionReservationConflictError extends Error {
  readonly code = "MEDIA_RECOGNITION_RESERVATION_ACTIVE";

  constructor() {
    super(
      "This media asset is reserved by an active recognition batch. Wait for the batch to finish or cancel it before deleting media data.",
    );
    this.name = "MediaRecognitionReservationConflictError";
  }
}

export type SingleMediaRecognitionReservation = {
  _id: ObjectId;
  owner: string;
  assetId: ObjectId;
  sha256: string;
  state: "preparing" | "active";
  singleRecognitionJobId: ObjectId;
  singleRecognitionClaimId: string;
  expiresAt?: Date;
};

export async function claimSingleMediaRecognitionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    sha256: string;
    jobId: ObjectId | string;
    claimId: string;
    expiresAt: Date;
  },
): Promise<SingleMediaRecognitionReservation> {
  const assetId = objectId(input.assetId);
  const jobId = objectId(input.jobId);
  const _id = mediaRecognitionAssetReservationId(input.owner, assetId);
  const now = new Date();
  const reservation = {
    _id,
    owner: input.owner,
    assetId,
    sha256: input.sha256,
    state: "preparing" as const,
    singleRecognitionJobId: jobId,
    singleRecognitionClaimId: input.claimId,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  const collection = db.collection<any>(RESERVATIONS);
  try {
    await collection.insertOne(reservation);
    return reservation;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  const current = await collection.findOne({ _id, owner: input.owner });
  if (
    ["preparing", "active"].includes(String(current?.state ?? "")) &&
    String(current?.singleRecognitionJobId ?? "") === String(jobId) &&
    current?.singleRecognitionClaimId === input.claimId &&
    current?.sha256 === input.sha256
  ) {
    const resumed = await collection.findOneAndUpdate(
      {
        _id,
        owner: input.owner,
        assetId,
        state: current.state,
        singleRecognitionJobId: jobId,
        singleRecognitionClaimId: input.claimId,
        sha256: input.sha256,
      },
      current.state === "preparing"
        ? {
          $max: { expiresAt: input.expiresAt },
          $set: { updatedAt: now },
        }
        : { $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    if (resumed) return resumed as SingleMediaRecognitionReservation;
  }
  if (["preparing", "active"].includes(String(current?.state ?? ""))) {
    throw new MediaRecognitionReservationConflictError();
  }
  throw new Error(
    "Media deletion owns this asset. Finish or recover it before starting recognition.",
  );
}

export async function activateSingleMediaRecognitionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    jobId: ObjectId | string;
    claimId: string;
  },
): Promise<SingleMediaRecognitionReservation> {
  const assetId = objectId(input.assetId);
  const jobId = objectId(input.jobId);
  const collection = db.collection<any>(RESERVATIONS);
  const activated = await collection.findOneAndUpdate(
    {
      _id: mediaRecognitionAssetReservationId(input.owner, assetId),
      owner: input.owner,
      assetId,
      state: "preparing",
      singleRecognitionJobId: jobId,
      singleRecognitionClaimId: input.claimId,
    },
    {
      $set: { state: "active", updatedAt: new Date() },
      $unset: { expiresAt: "" },
    },
    { returnDocument: "after" },
  );
  if (activated) return activated as SingleMediaRecognitionReservation;
  const current = await collection.findOne({
    _id: mediaRecognitionAssetReservationId(input.owner, assetId),
    owner: input.owner,
    assetId,
    state: "active",
    singleRecognitionJobId: jobId,
    singleRecognitionClaimId: input.claimId,
  });
  if (current) return current as SingleMediaRecognitionReservation;
  throw new MediaRecognitionReservationConflictError();
}

export async function touchSingleMediaRecognitionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    jobId: ObjectId | string;
    claimId: string;
  },
): Promise<boolean> {
  const assetId = objectId(input.assetId);
  const jobId = objectId(input.jobId);
  return Boolean(
    await db.collection<any>(RESERVATIONS).findOneAndUpdate(
      {
        _id: mediaRecognitionAssetReservationId(input.owner, assetId),
        owner: input.owner,
        assetId,
        state: "active",
        singleRecognitionJobId: jobId,
        singleRecognitionClaimId: input.claimId,
      },
      { $set: { lastOwnerCheckAt: new Date(), updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 1 } },
    ),
  );
}

export async function releaseSingleMediaRecognitionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    jobId: ObjectId | string;
    claimId: string;
  },
): Promise<void> {
  const assetId = objectId(input.assetId);
  await db.collection(RESERVATIONS).deleteOne({
    _id: mediaRecognitionAssetReservationId(input.owner, assetId),
    owner: input.owner,
    assetId,
    state: { $in: ["preparing", "active"] },
    singleRecognitionJobId: objectId(input.jobId),
    singleRecognitionClaimId: input.claimId,
  });
}

export type MediaDeletionReservation = {
  _id: ObjectId;
  owner: string;
  assetId: ObjectId;
  state: "deleting" | "confirming" | "cancelling";
  deletionTarget: MediaDeletionReservationTarget;
  deletionClaimId: string;
  deletionPreviewId?: ObjectId;
  expiresAt?: Date;
  deletionLeaseExpiredAt?: Date;
};

export async function claimMediaDeletionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    target: MediaDeletionReservationTarget;
    claimId?: string;
    deletionPreviewId?: ObjectId;
    expiresAt: Date;
  },
): Promise<MediaDeletionReservation> {
  const assetId = objectId(input.assetId);
  const _id = mediaRecognitionAssetReservationId(input.owner, assetId);
  const claimId = input.claimId ?? randomUUID();
  const now = new Date();
  const reservation: MediaDeletionReservation & {
    createdAt: Date;
    updatedAt: Date;
  } = {
    _id,
    owner: input.owner,
    assetId,
    state: "deleting",
    deletionTarget: input.target,
    deletionClaimId: claimId,
    ...(input.deletionPreviewId
      ? { deletionPreviewId: input.deletionPreviewId }
      : {}),
    ...(input.target === "managed_original"
      ? { expiresAt: input.expiresAt }
      : { deletionLeaseExpiredAt: input.expiresAt }),
    createdAt: now,
    updatedAt: now,
  };
  const collection = db.collection<any>(RESERVATIONS);
  try {
    await collection.insertOne(reservation);
    return reservation;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }

  let current = await collection.findOne({ _id, owner: input.owner });
  if (
    ["deleting", "confirming"].includes(String(current?.state ?? "")) &&
    current.deletionTarget === input.target &&
    current.deletionClaimId === claimId &&
    (!input.deletionPreviewId ||
      String(current.deletionPreviewId ?? "") ===
        String(input.deletionPreviewId))
  ) {
    const resumed = await collection.findOneAndUpdate(
      {
        _id,
        owner: input.owner,
        assetId,
        state: current.state,
        deletionTarget: input.target,
        deletionClaimId: claimId,
        ...(input.deletionPreviewId
          ? { deletionPreviewId: input.deletionPreviewId }
          : {}),
      },
      current.state === "confirming"
        ? {
          $max: { deletionLeaseExpiredAt: input.expiresAt },
          $set: { updatedAt: now },
          $unset: { expiresAt: "" },
        }
        : {
          $max: input.target === "managed_original"
            ? { expiresAt: input.expiresAt }
            : { deletionLeaseExpiredAt: input.expiresAt },
          $set: { updatedAt: now },
        },
      { returnDocument: "after" },
    );
    if (resumed) return resumed as MediaDeletionReservation;
    current = await collection.findOne({ _id, owner: input.owner });
  }
  if (
    current?.state === "deleting" &&
    current.deletionTarget === "managed_original" &&
    input.target === "managed_original" &&
    current.expiresAt &&
    new Date(current.expiresAt).getTime() <= now.getTime()
  ) {
    const {
      _id: _reservationId,
      ...reservationFields
    } = reservation;
    const reclaimed = await collection.findOneAndUpdate(
      {
        _id,
        owner: input.owner,
        state: "deleting",
        deletionClaimId: current.deletionClaimId,
        expiresAt: { $lte: now },
      },
      {
        $set: reservationFields,
        $unset: { batchId: "", sha256: "", deletionLeaseExpiredAt: "" },
      },
      { returnDocument: "after" },
    );
    if (reclaimed) return reclaimed as MediaDeletionReservation;
  }
  if (["active", "preparing"].includes(String(current?.state ?? ""))) {
    throw new MediaRecognitionReservationConflictError();
  }
  throw new Error(
    current?.state === "deleting" &&
      current.deletionTarget !== "managed_original" &&
      (current.deletionLeaseExpiredAt ?? current.expiresAt) &&
      new Date(current.deletionLeaseExpiredAt ?? current.expiresAt)
          .getTime() <= now.getTime()
      ? "A previous media deletion still owns this asset; explicit recovery is required before retrying"
      : "Another media deletion is already in progress; retry after it finishes",
  );
}

export async function releaseMediaDeletionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    target: MediaDeletionReservationTarget;
    claimId: string;
    states?: Array<"deleting" | "confirming" | "cancelling">;
  },
): Promise<void> {
  const assetId = objectId(input.assetId);
  await db.collection(RESERVATIONS).deleteOne({
    _id: mediaRecognitionAssetReservationId(input.owner, assetId),
    owner: input.owner,
    assetId,
    state: { $in: input.states ?? ["deleting", "confirming", "cancelling"] },
    deletionTarget: input.target,
    deletionClaimId: input.claimId,
  });
}

export async function loadMediaDeletionReservation(
  db: Db,
  owner: string,
  assetIdValue: ObjectId | string,
): Promise<MediaDeletionReservation | null> {
  const assetId = objectId(assetIdValue);
  return await db.collection<any>(RESERVATIONS).findOne({
    _id: mediaRecognitionAssetReservationId(owner, assetId),
    owner,
    assetId,
    state: { $in: ["deleting", "confirming", "cancelling"] },
  }) as MediaDeletionReservation | null;
}

export async function loadManagedOriginalDeletionReservationByPreview(
  db: Db,
  owner: string,
  deletionPreviewId: ObjectId,
): Promise<MediaDeletionReservation | null> {
  return await db.collection<any>(RESERVATIONS).findOne({
    owner,
    state: { $in: ["deleting", "confirming", "cancelling"] },
    deletionTarget: "managed_original",
    deletionPreviewId,
  }) as MediaDeletionReservation | null;
}

export async function claimMediaDerivedDeletionState(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    target: Exclude<MediaDeletionReservationTarget, "managed_original">;
    claimId: string;
    expiresAt: Date;
    now?: Date;
  },
) {
  const assetId = objectId(input.assetId);
  const now = input.now ?? new Date();
  return await db.collection<any>("media_assets").findOneAndUpdate(
    {
      _id: assetId,
      owner: input.owner,
      status: { $nin: ["queued", "processing"] },
      originalDeletionPending: { $exists: false },
      $or: [
        { derivedDeletionPending: { $exists: false } },
        { "derivedDeletionPending.claimId": input.claimId },
      ],
    },
    {
      $set: {
        derivedDeletionPending: {
          target: input.target,
          claimId: input.claimId,
          expiresAt: input.expiresAt,
          startedAt: now,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
}

async function transitionMediaDeletionReservation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    target: MediaDeletionReservationTarget;
    claimId: string;
    deletionPreviewId?: ObjectId;
    from: "deleting";
    to: "confirming" | "cancelling";
    expiresAt: Date;
  },
): Promise<MediaDeletionReservation> {
  const assetId = objectId(input.assetId);
  const reservation = await db.collection<any>(RESERVATIONS).findOneAndUpdate(
    {
      _id: mediaRecognitionAssetReservationId(input.owner, assetId),
      owner: input.owner,
      assetId,
      state: input.from,
      deletionTarget: input.target,
      deletionClaimId: input.claimId,
      ...(input.deletionPreviewId
        ? { deletionPreviewId: input.deletionPreviewId }
        : {}),
    },
    {
      $set: {
        state: input.to,
        deletionLeaseExpiredAt: input.expiresAt,
        updatedAt: new Date(),
      },
      $unset: { expiresAt: "" },
    },
    { returnDocument: "after" },
  );
  if (reservation) return reservation as MediaDeletionReservation;
  const current = await db.collection<any>(RESERVATIONS).findOne({
    _id: mediaRecognitionAssetReservationId(input.owner, assetId),
    owner: input.owner,
    assetId,
  });
  if (
    current?.state === input.to &&
    current.deletionTarget === input.target &&
    current.deletionClaimId === input.claimId
  ) {
    return current as MediaDeletionReservation;
  }
  throw new Error(
    input.to === "confirming"
      ? "Original deletion preview is stale; review again"
      : "Original deletion confirmation already started",
  );
}

export async function beginManagedOriginalDeletionConfirmation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    claimId: string;
    deletionPreviewId: ObjectId;
    expiresAt: Date;
  },
) {
  return await transitionMediaDeletionReservation(db, {
    ...input,
    target: "managed_original",
    from: "deleting",
    to: "confirming",
  });
}

export async function beginManagedOriginalDeletionCancellation(
  db: Db,
  input: {
    owner: string;
    assetId: ObjectId | string;
    claimId: string;
    deletionPreviewId: ObjectId;
    expiresAt: Date;
  },
) {
  return await transitionMediaDeletionReservation(db, {
    ...input,
    target: "managed_original",
    from: "deleting",
    to: "cancelling",
  });
}

export async function loadMediaRecognitionReservationSummary(
  db: Db,
  owner: string,
  assetIdValue: ObjectId | string,
) {
  const assetId = objectId(assetIdValue);
  const reservation = await db.collection<any>(RESERVATIONS).findOne({
    _id: mediaRecognitionAssetReservationId(owner, assetId),
    owner,
    assetId,
    state: { $in: ["preparing", "active"] },
  }, {
    projection: {
      state: 1,
      batchId: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  if (!reservation) return null;
  const batch = reservation.batchId
    ? await db.collection<any>("media_recognition_batches").findOne({
      _id: objectId(reservation.batchId),
      owner,
    }, {
      projection: {
        status: 1,
        profileName: 1,
        counts: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    : null;
  return {
    state: reservation.state,
    batchId: reservation.batchId ?? null,
    batch: batch
      ? {
        status: batch.status,
        profileName: batch.profileName,
        counts: batch.counts,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      }
      : null,
  };
}
