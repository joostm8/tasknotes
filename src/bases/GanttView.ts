import { TFile } from "obsidian";
import type { BasesView, BasesViewFactory } from "obsidian";
import TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import { BasesViewBase } from "./BasesViewBase";
import type { BasesTaskUpdateSource } from "./basesUpdateEvents";
import { identifyTaskNotesFromBasesData } from "./helpers";

type GanttGranularity = "day" | "week" | "month" | "quarter" | "year";

const GRANULARITIES: readonly GanttGranularity[] = ["day", "week", "month", "quarter", "year"];
const COLUMN_WIDTHS: Record<GanttGranularity, number> = { day: 42, week: 96, month: 132, quarter: 164, year: 180 };

function parseTaskDate(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function startOfUnit(date: Date, granularity: GanttGranularity): Date {
	const result = new Date(date);
	result.setHours(0, 0, 0, 0);
	if (granularity === "week") result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
	if (granularity === "month" || granularity === "quarter" || granularity === "year") result.setDate(1);
	if (granularity === "quarter") result.setMonth(Math.floor(result.getMonth() / 3) * 3);
	if (granularity === "year") result.setMonth(0);
	return result;
}

function addUnit(date: Date, granularity: GanttGranularity): Date {
	const result = new Date(date);
	if (granularity === "day") result.setDate(result.getDate() + 1);
	if (granularity === "week") result.setDate(result.getDate() + 7);
	if (granularity === "month") result.setMonth(result.getMonth() + 1);
	if (granularity === "quarter") result.setMonth(result.getMonth() + 3);
	if (granularity === "year") result.setFullYear(result.getFullYear() + 1);
	return result;
}

function formatUnitLabel(date: Date, granularity: GanttGranularity): string {
	if (granularity === "day") return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	if (granularity === "week") return `Week of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
	if (granularity === "month") return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
	if (granularity === "quarter") return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
	return String(date.getFullYear());
}

export class GanttView extends BasesViewBase {
	type = "taskNotesGantt";
	private granularity: GanttGranularity = "week";
	private chartScrollEl: HTMLElement | null = null;

	onload(): void {
		this.readViewOptions();
		super.onload();
	}

	async render(): Promise<void> {
		if (!this.rootElement || !this.data?.data) return;
		this.readViewOptions();
		const tasks = this.applySearchFilter(await identifyTaskNotesFromBasesData(this.dataAdapter.extractDataItems(), this.plugin));
		this.rootElement.empty();
		this.chartScrollEl = null;
		this.setupSearch(this.rootElement);

		if (tasks.length === 0) {
			this.rootElement.createDiv({ cls: "tn-gantt-empty", text: "No tasks match this view." });
			return;
		}

		const dates = tasks.flatMap((task) => [parseTaskDate(task.scheduled), parseTaskDate(task.due)]).filter((date): date is Date => date !== null);
		const now = new Date();
		const firstDate = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : now;
		const lastDate = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : now;
		const axisStart = startOfUnit(firstDate, this.granularity);
		const axisEnd = addUnit(startOfUnit(lastDate, this.granularity), this.granularity);
		const units: Date[] = [];
		for (let date = axisStart; date <= axisEnd; date = addUnit(date, this.granularity)) units.push(date);

		const chart = this.rootElement.createDiv({ cls: "tn-gantt" });
		chart.addEventListener("wheel", (event) => this.handleZoom(event), { passive: false });
		const labels = chart.createDiv({ cls: "tn-gantt__labels" });
		labels.createDiv({ cls: "tn-gantt__labels-header", text: "Task" });
		for (const task of tasks) this.renderTaskLabel(labels, task);

		const scroll = chart.createDiv({ cls: "tn-gantt__scroll" });
		labels.addEventListener("scroll", () => {
			if (scroll.scrollTop !== labels.scrollTop) scroll.scrollTop = labels.scrollTop;
		});
		scroll.addEventListener("scroll", () => {
			if (labels.scrollTop !== scroll.scrollTop) labels.scrollTop = scroll.scrollTop;
		});
		this.chartScrollEl = scroll;
		const timeline = scroll.createDiv({ cls: "tn-gantt__timeline" });
		timeline.style.setProperty("--tn-gantt-column-width", `${COLUMN_WIDTHS[this.granularity]}px`);
		timeline.style.setProperty("--tn-gantt-columns", String(units.length));
		const header = timeline.createDiv({ cls: "tn-gantt__header" });
		for (const unit of units) header.createDiv({ cls: "tn-gantt__unit", text: formatUnitLabel(unit, this.granularity) });
		for (const task of tasks) this.renderTaskRow(timeline, task, axisStart, units.length);
	}

	renderError(error: Error): void {
		this.rootElement?.empty();
		this.rootElement?.createDiv({ cls: "tn-gantt-empty", text: `Unable to render Gantt chart: ${error.message}` });
	}

	protected async handleTaskUpdate(_task: TaskInfo, _source?: BasesTaskUpdateSource): Promise<void> {
		await this.render();
	}

	getEphemeralState(): unknown {
		return { ...(super.getEphemeralState() as object), chartScrollLeft: this.chartScrollEl?.scrollLeft ?? 0 };
	}

	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		if (state && typeof state === "object" && "chartScrollLeft" in state) {
			const scrollLeft = (state as { chartScrollLeft?: unknown }).chartScrollLeft;
			if (typeof scrollLeft === "number") this.chartScrollEl?.scrollTo({ left: scrollLeft });
		}
	}

	private readViewOptions(): void {
		const value = this.config?.get?.("granularity");
		if (typeof value === "string" && GRANULARITIES.includes(value as GanttGranularity)) this.granularity = value as GanttGranularity;
	}

	private renderTaskLabel(container: HTMLElement, task: TaskInfo): void {
		const label = container.createEl("button", { cls: "tn-gantt__task-label", text: task.title || task.path });
		label.type = "button";
		label.addEventListener("click", (event) => {
			if (event.ctrlKey || event.metaKey) this.openTaskNote(task);
			else void this.plugin.openTaskEditModal(task);
		});
	}

	private renderTaskRow(timeline: HTMLElement, task: TaskInfo, axisStart: Date, unitCount: number): void {
		const row = timeline.createDiv({ cls: "tn-gantt__row" });
		for (let index = 0; index < unitCount; index++) row.createDiv({ cls: "tn-gantt__cell" });
		const scheduled = parseTaskDate(task.scheduled);
		const due = parseTaskDate(task.due);
		if (!scheduled || !due) return;
		const start = Math.max(0, this.getUnitOffset(axisStart, scheduled));
		const end = Math.min(unitCount, Math.max(start + 1, this.getUnitOffset(axisStart, due) + 1));
		if (start >= unitCount || end <= 0) return;
		const bar = row.createDiv({ cls: "tn-gantt__bar", attr: { "aria-label": `${task.title}: ${task.scheduled} to ${task.due}` } });
		bar.style.gridColumn = `${start + 1} / ${end + 1}`;
		bar.style.backgroundColor = this.plugin.priorityManager.getPriorityConfig(task.priority)?.color ?? "var(--color-accent)";
	}

	private getUnitOffset(axisStart: Date, date: Date): number {
		let index = 0;
		for (let cursor = new Date(axisStart); cursor < date; cursor = addUnit(cursor, this.granularity)) index++;
		return index;
	}

	private handleZoom(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const index = GRANULARITIES.indexOf(this.granularity);
		const next = Math.max(0, Math.min(GRANULARITIES.length - 1, index + (event.deltaY < 0 ? -1 : 1)));
		if (next !== index) {
			this.granularity = GRANULARITIES[next];
			void this.render();
		}
	}

	private openTaskNote(task: TaskInfo): void {
		const app = this.app || this.plugin.app;
		if (app.vault.getAbstractFileByPath(task.path) instanceof TFile) void app.workspace.openLinkText(task.path, "", true);
	}
}

export function buildGanttViewFactory(plugin: TaskNotesPlugin): BasesViewFactory {
	return (controller: unknown, containerEl: HTMLElement): BasesView => new GanttView(controller, containerEl, plugin) as unknown as BasesView;
}