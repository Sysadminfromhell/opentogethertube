import axios, { type AxiosResponse } from "axios";
import { ServiceAdapter } from "../serviceadapter.js";
import { getLogger } from "../logger.js";
import { conf } from "../ott-config.js";
import { Video, VideoMetadata, VideoService } from "ott-common/models/video.js";
import { InvalidVideoIdException } from "../exceptions.js";

const log = getLogger("soundcloud");

interface ScResolveResponse {
	kind: "track" | string;
	id?: number;
}

interface ScTrack {
	id: number;
	title: string;
	description?: string;
	duration: number; // ms
	artwork_url?: string;
	permalink_url?: string;
}

interface ScTranscodingRef {
	url: string; // URL to exchange for a signed CDN URL
	format: {
		protocol: "hls" | "progressive";
		mime_type: string;
	};
	quality?: string;
}

interface ScStreamsResponse {
	transcodings: ScTranscodingRef[];
}

//Known SoundCloud API URL
const SC_API = "https://api.soundcloud.com";

//RegEX for Accepted URLs
const SOUNDCLOUD_URL_RE =
	/^(?:https?:\/\/)?(?:m\.)?(?:soundcloud\.com|on\.soundcloud\.com|soundcloud\.app\.goo\.gl)\/.+/i;

type AuthOptions = {
	accessToken?: string;
};

export default class SoundCloudAdapter extends ServiceAdapter {
	api = axios.create({
		baseURL: SC_API,
		headers: { "User-Agent": `OpenTogetherTube @ ${conf.get("hostname")}` },
		timeout: 10000,
	});

	private auth: AuthOptions = {};

	get serviceId(): VideoService {
		return "soundcloud";
	}

	get isCacheSafe(): boolean {
		return false;
	}

	async initialize(): Promise<void> {
		this.auth = {
			accessToken: conf.get("info_extractor.soundcloud.access_token"),
		};
		if (!this.auth.accessToken) {
			throw new Error("SoundCloud config incomplete: need either client_id or access_token");
		}
	}

	canHandleURL(link: string): boolean {
		if (!link) {
			return false;
		}
		return /^\d+$/.test(link) || SOUNDCLOUD_URL_RE.test(link);
	}

	isCollectionURL(link: string): boolean {
		return false;
	}

	getVideoId(link: string): string {
		if (/^\d+$/.test(link)) {
			return link.trim();
		}
		return link.trim();
	}

	async fetchVideoInfo(videoId: string, properties?: (keyof VideoMetadata)[]): Promise<Video> {
		if (!this.auth.accessToken) {
			throw new Error("SoundCloud auth missing: provide client_id or access_token");
		}

		const scId = await this.resolveTrackId(videoId);

		const [trackRes, streamsRes]: [AxiosResponse<ScTrack>, AxiosResponse<ScStreamsResponse>] =
			await Promise.all([
				this.api.get<ScTrack>(`/tracks/${scId}`),
				this.api.get<ScStreamsResponse>(`/tracks/${scId}/streams`),
			]);

		const track = trackRes.data;
		const streams = streamsRes.data?.transcodings ?? [];
		if (!streams.length) {
			throw new InvalidVideoIdException(this.serviceId, String(scId));
		}

		// Prefer HLS, then progressive
		const hls = streams.find(t => t.format?.protocol === "hls");
		const prog = streams.find(t => t.format?.protocol === "progressive");
		const chosen = hls ?? prog;
		if (!chosen) {
			throw new Error("No playable SoundCloud transcodings found");
		}

		// Exchange transcoding ref for a signed CDN URL
		const playRes = await axios.get<{ url: string }>(chosen.url, {
			baseURL: undefined, // chosen.url is absolute
			headers: {
				"User-Agent": `OpenTogetherTube @ ${conf.get("hostname")}`,
				"Authorization": `Bearer ${this.auth.accessToken}`,
			},
			timeout: 10000, // 10sec
		});

		if (!playRes.data?.url) {
			throw new Error("Failed to materialize SoundCloud stream URL");
		}

		const base = {
			title: track.title,
			description: track.description ?? "",
			length: Math.max(0, Math.round((track.duration ?? 0) / 1000)),
			thumbnail: track.artwork_url
				? track.artwork_url.replace("-large", "-t500x500")
				: undefined,
		};

		if (chosen.format.protocol === "hls") {
			const video: Video = {
				service: "hls",
				id: playRes.data.url,
				...base,
				hls_url: playRes.data.url,
			};
			return video;
		} else {
			const video: Video = {
				service: "direct",
				id: playRes.data.url,
				...base,
			};
			return video;
		}
	}

	/**
	 * Resolves either a numeric ID or a URL via /resolve to a numeric track ID.
	 */
	private async resolveTrackId(input: string): Promise<number> {
		if (/^\d+$/.test(input)) {
			return Number(input);
		}
		if (!SOUNDCLOUD_URL_RE.test(input)) {
			throw new InvalidVideoIdException(this.serviceId, input);
		}

		const res = await this.api.get<ScResolveResponse>("/resolve", {
			params: { url: input },
			validateStatus: s => s >= 200 && s < 400,
		});

		if (!res.data || res.data.kind !== "track" || typeof res.data.id !== "number") {
			throw new InvalidVideoIdException(this.serviceId, input);
		}

		return res.data.id!;
	}
}
