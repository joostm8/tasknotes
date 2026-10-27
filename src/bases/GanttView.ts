import { TFile } from "obsidian";
import type { BasesView, BasesViewFactory } from "obsidian";
import TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import { BasesViewBase } from "./BasesViewBase";
import type { BasesTaskUpdateSource } from "./basesUpdateEvents";
import { identifyTaskNotesFromBasesData } from "./helpers";

type GanttGranularity = "day" | "week" | "month" | "quarter" | "year";

const GRANULARITIES: readonly GanttGranularity[] = ["day", "week", "month", "quarter", "year"];
const COLUMN_WIDTHS: Record<GanttGranularity, number> = { day: 60, week: 96, month: 132, quarter: 164, year: 180 };

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

const GRANULARITY_BUTTONS: ReadonlyArray<[GanttGranularity, string, string]> = [
	["year", "Y", "Year"],
	["quarter", "Q", "Quarter"],
	["month", "M", "Month"],
	["week", "W", "Week"],
	["day", "D", "Day"],
];

function formatDayMonth(date: Date): string {
	return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getIsoWeekNumber(date: Date): number {
	const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
	const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
	return Math.ceil(((target.getTime() - yearStart) / 86400000 + 1) / 7);
}

function formatUnitLabel(date: Date, granularity: GanttGranularity): string {
	if (granularity === "day") return formatDayMonth(date);
	if (granularity === "week") return `${getIsoWeekNumber(date)} - ${formatDayMonth(date)}`;
	if (granularity === "month") return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
	if (granularity === "quarter") return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
	return String(date.getFullYear());
}

export class GanttView extends BasesViewBase {
	type = "taskNotesGantt";
	private granularity: GanttGranularity = "week";
	private chartScrollEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private axisStart: Date | null = null;
	private axisUnits: Date[] = [];

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
		this.titleEl = null;
		this.setupSearch(this.rootElement);
		this.renderToolbar(this.rootElement);

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
		this.axisStart = axisStart;
		this.axisUnits = units;

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
		scroll.addEventListener("scroll", () => this.updateTitle());
		const timeline = scroll.createDiv({ cls: "tn-gantt__timeline" });
		timeline.style.setProperty("--tn-gantt-column-width", `${COLUMN_WIDTHS[this.granularity]}px`);
		timeline.style.setProperty("--tn-gantt-columns", String(units.length));
		const header = timeline.createDiv({ cls: "tn-gantt__header" });
		for (const unit of units) header.createDiv({ cls: "tn-gantt__unit", text: formatUnitLabel(unit, this.granularity) });
		for (const task of tasks) this.renderTaskRow(timeline, task, axisStart, units.length);
		this.renderTodayMarker(timeline, units);
		this.updateTitle();
	}

	private renderToolbar(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "tn-gantt__toolbar" });
		const left = toolbar.createDiv({ cls: "tn-gantt__toolbar-chunk" });
		const makeButton = (parent: HTMLElement, text: string, label: string, onClick: () => void): HTMLButtonElement => {
			const button = parent.createEl("button", { cls: "tn-gantt__button", text, attr: { "aria-label": label, title: label, type: "button" } });
			button.addEventListener("click", onClick);
			return button;
		};
		makeButton(left, "‹", "Previous", () => this.scrollByPage(-1));
		makeButton(left, "›", "Next", () => this.scrollByPage(1));
		makeButton(left, "Today", "Go to today", () => this.scrollToToday()).addClass("tn-gantt__button--today");
		this.titleEl = toolbar.createDiv({ cls: "tn-gantt__title" });
		const right = toolbar.createDiv({ cls: "tn-gantt__toolbar-chunk" });
		for (const [granularity, text, label] of GRANULARITY_BUTTONS) {
			const button = makeButton(right, text, label, () => this.setGranularity(granularity));
			button.toggleClass("is-active", granularity === this.granularity);
		}
	}

	private setGranularity(granularity: GanttGranularity): void {
		if (granularity === this.granularity) return;
		this.granularity = granularity;
		void this.render();
	}

	private scrollByPage(direction: number): void {
		const scroll = this.chartScrollEl;
		if (scroll) scroll.scrollBy({ left: direction * scroll.clientWidth * 0.8, behavior: "smooth" });
	}

	private scrollToToday(): void {
		const scroll = this.chartScrollEl;
		if (!scroll || !this.axisStart || this.axisUnits.length === 0) return;
		const columnWidth = COLUMN_WIDTHS[this.granularity];
		const now = Date.now();
		const containing = this.axisUnits.findLastIndex((unit) => unit.getTime() <= now);
		if (containing < 0 || containing >= this.axisUnits.length - 1) return;
		scroll.scrollTo({ left: containing * columnWidth - (scroll.clientWidth - columnWidth) / 2, behavior: "smooth" });
	}

	private updateTitle(): void {
		const scroll = this.chartScrollEl;
		if (!this.titleEl || !scroll || this.axisUnits.length === 0) return;
		const columnWidth = COLUMN_WIDTHS[this.granularity];
		const last = this.axisUnits.length - 1;
		const first = Math.min(last, Math.max(0, Math.floor(scroll.scrollLeft / columnWidth)));
		const lastVisible = Math.min(last, Math.max(first, Math.ceil((scroll.scrollLeft + scroll.clientWidth) / columnWidth) - 1));
		const start = this.axisUnits[first];
		const end = addUnit(this.axisUnits[lastVisible], this.granularity);
		end.setDate(end.getDate() - 1);
		const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
		this.titleEl.setText(`${start.toLocaleDateString(undefined, options)} – ${end.toLocaleDateString(undefined, options)}`);
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

	private renderTodayMarker(timeline: HTMLElement, units: Date[]): void {
		const today = startOfUnit(new Date(), "day");
		const index = units.findLastIndex((unit) => unit.getTime() <= today.getTime());
		if (index < 0 || index >= units.length - 1) return;
		const columnWidth = COLUMN_WIDTHS[this.granularity];
		const unitStart = units[index].getTime();
		const fraction = (today.getTime() - unitStart) / (addUnit(units[index], this.granularity).getTime() - unitStart);
		const isDay = this.granularity === "day";
		const marker = timeline.createDiv({ cls: isDay ? "tn-gantt__today tn-gantt__today--day" : "tn-gantt__today" });
		marker.style.left = `${(index + fraction) * columnWidth}px`;
		if (isDay) marker.style.width = `${columnWidth}px`;
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