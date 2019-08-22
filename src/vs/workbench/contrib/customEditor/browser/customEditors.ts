/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UnownedDisposable } from 'vs/base/common/lifecycle';
import { endsWith } from 'vs/base/common/strings';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IEditor, IEditorInput } from 'vs/workbench/common/editor';
import { webviewEditorsExtensionPoint } from 'vs/workbench/contrib/customEditor/browser/extensionPoint';
import { CustomEditorInfo, ICustomEditorService } from 'vs/workbench/contrib/customEditor/common/customEditor';
import { FileEditorInput } from 'vs/workbench/contrib/files/common/editors/fileEditorInput';
import { TEXT_FILE_EDITOR_ID } from 'vs/workbench/contrib/files/common/files';
import { IWebviewService } from 'vs/workbench/contrib/webview/browser/webview';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService, IOpenEditorOverride } from 'vs/workbench/services/editor/common/editorService';
import { CustomFileEditorInput } from './customEditorInput';

export class CustomEditorService implements ICustomEditorService {
	_serviceBrand: any;

	private readonly customEditors: Array<CustomEditorInfo & { extensions: readonly string[] }> = [];

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		webviewEditorsExtensionPoint.setHandler(extensions => {
			for (const extension of extensions) {
				for (const webviewEditorContribution of extension.value) {
					this.customEditors.push({
						id: webviewEditorContribution.viewType,
						displayName: webviewEditorContribution.displayName,
						extensions: webviewEditorContribution.extensions || []
					});
				}
			}
		});
	}

	public getCustomEditorsForResource(resource: URI): readonly CustomEditorInfo[] {
		const out: CustomEditorInfo[] = [];
		for (const customEditor of this.customEditors) {
			if (customEditor.extensions.some(extension => endsWith(resource.toString(), extension))) {
				out.push(customEditor);
			}
		}

		return out;
	}

	public async promptOpenWith(
		resource: URI,
		options?: ITextEditorOptions,
		group?: IEditorGroup,
	): Promise<void> {
		const preferredEditors = await this.getCustomEditorsForResource(resource);
		const pick = await this.quickInputService.pick([
			{
				label: 'Text',
				id: TEXT_FILE_EDITOR_ID,
			},
			...preferredEditors.map((editorDescriptor): IQuickPickItem => ({
				label: editorDescriptor.displayName,
				id: editorDescriptor.id
			}))
		], {});

		if (!pick) {
			return;
		}

		if (pick.id === TEXT_FILE_EDITOR_ID) {
			const editor = this.instantiationService.createInstance(FileEditorInput, resource, undefined, undefined);
			this.editorService.openEditor(editor, options, group);
		} else {
			this.openWith(resource, pick.id!, options, group);
		}
	}

	public openWith(
		resource: URI,
		customEditorViewType: string,
		options?: ITextEditorOptions,
		group?: IEditorGroup,
	): Promise<IEditor | undefined> {
		const id = generateUuid();
		const webview = this.webviewService.createWebviewEditorOverlay(id, {}, {});
		const input = this.instantiationService.createInstance(CustomFileEditorInput, resource, customEditorViewType, id, new UnownedDisposable(webview));
		if (group) {
			input.updateGroup(group!.id);
		}
		return this.editorService.openEditor(input, options, group);
	}
}

export class CustomEditorContribution implements IWorkbenchContribution {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICustomEditorService private readonly customEditorService: ICustomEditorService,
	) {
		this.editorService.overrideOpenEditor((editor, options, group) => this.onEditorOpening(editor, options, group));
	}

	private getConfiguredCustomEditor(resource: URI): string | undefined {
		const config = this.configurationService.getValue<{ [key: string]: string }>('workbench.editor.custom') || {};
		for (const ext of Object.keys(config)) {
			if (endsWith(resource.toString(), ext)) {
				return config[ext];
			}
		}
		return undefined;
	}

	private onEditorOpening(
		editor: IEditorInput,
		options: ITextEditorOptions | undefined,
		group: IEditorGroup
	): IOpenEditorOverride | undefined {
		if (editor instanceof CustomFileEditorInput) {
			return;
		}

		const resource = editor.getResource();
		if (!resource) {
			return;
		}

		const customEditors = this.customEditorService.getCustomEditorsForResource(resource);
		if (!customEditors.length) {
			return;
		}

		for (const input of group.editors) {
			if (input instanceof CustomFileEditorInput && input.editorResource.toString() === resource.toString()) {
				return {
					override: group.openEditor(input, options).then(withNullAsUndefined)
				};
			}
		}

		return {
			override: (async () => {
				const preferedViewType = this.getConfiguredCustomEditor(resource);
				if (preferedViewType) {
					return this.customEditorService.openWith(resource, preferedViewType, options, group);
				} else {
					// prompt the user for which editor they wish to use
					this.customEditorService.promptOpenWith(resource, options, group);
					return undefined; // TODO: open normal editor here during prompt
				}
			})()
		};
	}
}
