import type { Component } from "@earendil-works/pi-tui";

type RenderCallTool<TArgs, TTheme, TContext> = {
	renderCall?: (args: TArgs, theme: TTheme, context: TContext) => Component;
};

type RenderResultTool<TOptions, TTheme, TContext> = {
	renderResult?: (result: any, options: TOptions, theme: TTheme, context: TContext) => Component;
};

export type BuiltInRendererSlots<TBuiltInState extends object = Record<string, unknown>> = {
	builtInCallComponent?: Component;
	builtInResultComponent?: Component;
	builtInRendererState?: TBuiltInState;
};

export function ensureBuiltInRendererState<TBuiltInState extends object>(state: BuiltInRendererSlots<TBuiltInState>): TBuiltInState {
	state.builtInRendererState ??= {} as TBuiltInState;
	return state.builtInRendererState;
}

export function renderExpandedCall<TArgs, TTheme, TContext extends { expanded?: boolean; state?: unknown; lastComponent?: unknown }, TBuiltInState extends object>(
	original: RenderCallTool<TArgs, TTheme, TContext>,
	args: TArgs,
	theme: TTheme,
	context: TContext,
	state: BuiltInRendererSlots<TBuiltInState>,
): Component | undefined {
	const renderCall = original.renderCall;
	if (!context.expanded || !renderCall) return undefined;
	const component = renderCall(args, theme, {
		...context,
		state: ensureBuiltInRendererState(state),
		lastComponent: state.builtInCallComponent,
	} as TContext);
	state.builtInCallComponent = component;
	return component;
}

export function getExpandedResultRenderer<
	TResult,
	TOptions extends { expanded?: boolean },
	TTheme,
	TContext extends { state?: unknown; lastComponent?: unknown },
	TBuiltInState extends object,
>(
	original: RenderResultTool<TOptions, TTheme, TContext>,
	result: TResult,
	options: TOptions,
	theme: TTheme,
	context: TContext,
	state?: BuiltInRendererSlots<TBuiltInState>,
): (() => Component) | undefined {
	const renderResult = original.renderResult;
	if (!options.expanded || !renderResult) return undefined;
	if (!state) return () => renderResult(result, options, theme, context);

	return () => {
		const component = renderResult(result, options, theme, {
			...context,
			state: ensureBuiltInRendererState(state),
			lastComponent: state.builtInResultComponent,
		} as TContext);
		state.builtInResultComponent = component;
		return component;
	};
}
