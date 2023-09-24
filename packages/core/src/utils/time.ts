const MS_IN_SECOND = 1000;
export function MS_TO_SECONDS(ms: number) {
	return ms / MS_IN_SECOND;
}

export function SECONDS_TO_MS(seconds: number) {
	return seconds * MS_IN_SECOND;
}

export function HOURS_TO_MS(hours: number) {
	return SECONDS_TO_MS(hours * 60 * 60);
}
