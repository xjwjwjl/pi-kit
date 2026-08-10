export class RemoteOpsError extends Error {
	readonly code: string;

	constructor(message: string, code: string = "REMOTE_OPS_ERROR") {
		super(message);
		this.name = "RemoteOpsError";
		this.code = code;
	}
}

export class RemoteOpsCancelledError extends RemoteOpsError {
	constructor(message = "Operation cancelled") {
		super(message, "CANCELLED");
		this.name = "RemoteOpsCancelledError";
	}
}

export class RemoteTransportError extends RemoteOpsError {
	constructor(message: string) {
		super(message, "REMOTE_TRANSPORT_ERROR");
		this.name = "RemoteTransportError";
	}
}

export class IntegrityError extends RemoteOpsError {
	constructor(message: string) {
		super(message, "INTEGRITY_ERROR");
		this.name = "IntegrityError";
	}
}
