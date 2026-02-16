import ObsidianGoogleDrive from "main";
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { pull } from "./pull";

class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, "create" | "delete" | "modify"][],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.proceed = proceed;
	}
	onClose() {
		this.proceed(false);
	}
}

class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: "create" | "delete" | "modify",
		files: string[],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		this.proceed = proceed;
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ["id", "mimeType", "properties", "modifiedTime"],
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [file.properties.path, file])
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path].properties.path === folderMimeType
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);
			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder))
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToFile[path].properties.path !== folderMimeType
		);

		await batchAsyncs(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(this.filePathToId[path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path].modifiedTime
				);
			})
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive.getFile(this.filePathToId[path]).arrayBuffer(),
			this.t.drive.getFileMetadata(this.filePathToId[path]),
		]);
		if (!onlineFile || !metadata) {
			return new Notice("An error occurred fetching Google Drive files.");
		}
		return this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
	}
}

export const push = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
	);

	const { vault } = t.app;
	const adapter = vault.adapter;

	// 🚀 AUTO PUSH — NO CONFIRMATION
	const proceed = true;
	if (!proceed) return;

	const syncNotice = await t.startSync();
	await pull(t, true);

	const operations = Object.entries(t.settings.operations);

	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const pathsToIds = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	const configOnDrive = await t.drive.searchFiles({
		include: ["properties"],
		matches: [{ properties: { config: "true" } }],
	});
	if (!configOnDrive) {
		return new Notice("An error occurred fetching Google Drive files.");
	}

	await Promise.all(
		configOnDrive.map(async ({ properties }) => {
			if (!(await adapter.exists(properties.path))) {
				deletes.push([properties.path, "delete"]);
			}
		})
	);

	if (deletes.length) {
		const deleteRequest = await t.drive.batchDelete(
			deletes.map(([path]) => pathsToIds[path])
		);
		if (!deleteRequest) {
			return new Notice("An error occurred deleting Google Drive files.");
		}
		deletes.forEach(([path]) => delete t.settings.driveIdToPath[path]);
	}

	syncNotice.setMessage("Syncing (33%)");

	if (creates.length) {
		let completed = 0;
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const batches = foldersToBatches(folders);
			for (const batch of batches) {
				await batchAsyncs(
					batch.map((folder) => async () => {
						const id = await t.drive.createFolder({
							name: folder.name,
							parent: folder.parent
								? pathsToIds[folder.parent.path]
								: undefined,
							properties: { path: folder.path },
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							return new Notice("Error creating folders.");
						}
						completed++;
						syncNotice.setMessage(
							getSyncMessage(33, 66, completed, files.length)
						);
						t.settings.driveIdToPath[id] = folder.path;
						pathsToIds[folder.path] = id;
					})
				);
			}
		}

		const notes = files.filter((file) => file instanceof TFile) as TFile[];

		await batchAsyncs(
			notes.map((note) => async () => {
				const id = await t.drive.uploadFile(
					new Blob([await vault.readBinary(note)]),
					note.name,
					note.parent ? pathsToIds[note.parent.path] : undefined,
					{
						properties: { path: note.path },
						modifiedTime: new Date().toISOString(),
					}
				);
				if (!id) return new Notice("Error uploading file.");
				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);
				t.settings.driveIdToPath[id] = note.path;
			})
		);
	}

	if (modifies.length) {
		let completed = 0;
		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file) => file instanceof TFile) as TFile[];

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		await batchAsyncs(
			files.map((file) => async () => {
				const id = await t.drive.updateFile(
					pathToId[file.path],
					new Blob([await vault.readBinary(file)]),
					{ modifiedTime: new Date().toISOString() }
				);
				if (!id) return new Notice("Error modifying file.");
				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, files.length)
				);
			})
		);
	}

	await t.drive.updateFile(
		pathsToIds[vault.configDir + "/plugins/google-drive-sync/data.json"],
		new Blob([JSON.stringify(t.settings, null, 2)]),
		{ modifiedTime: new Date().toISOString() }
	);

	t.settings.operations = {};
	await t.endSync(syncNotice, false);
	new Notice("Sync complete!");
};
