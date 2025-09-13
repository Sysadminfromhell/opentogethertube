import axios from "axios";
import _ from "lodash";
import { ServiceAdapter } from "../serviceadapter.js";
import { getLogger } from "../logger.js";
import { Video } from "ott-common/models/video.js";
import { conf } from "../ott-config.js";

const log = getLogger("spotifyToYt");

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

// Spotify API URLs
const SpotifyApiTokenURL = "https://accounts.spotify.com/api/token";
const SpotifyApiTrackURL = "https://api.spotify.com/v1/tracks/";
const SpotifyApiPlaylistURL = "https://api.spotify.com/v1/playlists/";

// RegEx for Spotify URL handling
const SPOTIFY_ID_RE = "[A-Za-z0-9]{22}";
const SPOTIFY_HOST_RE = /(^|\.)spotify\.com$/i;
const SPOTIFY_RE_PATHS = new RegExp(
	String.raw`^/` +
		String.raw`(?:intl-[a-z]{2}(?:-[A-Z]{2})?/)?` + // optional intl-xx(-YY)/
		String.raw`(?:embed/)?` + // optional embed/
		String.raw`(?<type>track|playlist)/(?<id>${SPOTIFY_ID_RE})` +
		String.raw`(?:[/?#].*)?$`,
	"i"
);

// Unified AXIOS Timeout 10 secs
const AXIOS_TIMEOUT_MS = 10000;

// Spotify Kind respose
export type SpotifyKind = "track" | "playlist";

// Interfaces for answers from API
interface SpotifyApiAnswer {
	access_token: string;
	token_type: string;
	expires_in: number;
}

interface SpotifyImage {
	url: string;
	width: number;
	height: number;
}

interface SpotifyArtist {
	name: string;
}

interface SpotifyAnswerTrack {
	name: string;
	uri: string;
	artists: SpotifyArtist[];
	album: { images: SpotifyImage[] };
}

interface SpotifyAnswerPlaylist {
	name: string;
	images: SpotifyImage[];
	tracks: {
		items: { track: SpotifyAnswerTrack }[];
	};
}

function getBestImage(image: SpotifyImage[]): SpotifyImage | undefined {
	if (!image) {
		return undefined;
	} else {
		return image.reduce((prev, curr) => (curr.width > prev.width ? curr : prev));
	}
}

function parseSpotify(input: string): { kind: SpotifyKind; id: string } | null {
	const mUri = input.match(new RegExp(`^spotify:(track|playlist):(${SPOTIFY_ID_RE})`, "i"));
	if (mUri) return { kind: mUri[1].toLowerCase() as SpotifyKind, id: mUri[2] };

	let u: URL;
	try {
		u = new URL(input);
	} catch {
		return null;
	}
	if (!SPOTIFY_HOST_RE.test(u.hostname)) {
		return null;
	}

	const m = u.pathname.match(SPOTIFY_RE_PATHS);
	if (!m || !m.groups) {
		return null;
	}

	return { kind: m.groups.type.toLowerCase() as SpotifyKind, id: m.groups.id };
}

function buildYtQuery(title: string, artists: string[]): string {
	const a = artists[0] ?? "";
	return `${title} ${a}`.trim();
}

async function ytSearchUrl(query: string): Promise<string> {
	const { data } = await axios.get(YT_SEARCH_URL, {
		params: {
			q: query,
			type: "video",
			maxResults: 1,
			part: "snippet",
			fields: "items(id/videoId)",
			safeSearch: "none",
		},
		timeout: AXIOS_TIMEOUT_MS,
	});
	const vid = data?.items?.[0]?.id?.videoId;
	if (!vid) throw new Error("No YouTube result");
	return `https://www.youtube.com/watch?v=${vid}`;
}

export default class spotifyToYt extends ServiceAdapter {
	clientid: string;
	clientsecret: string;

	constructor(clientid: string, clientsecret: string) {
		super();
		this.clientid = clientid;
		this.clientsecret = clientsecret;
	}

	get serviceId(): "spotifyToYt" {
		return "spotifyToYt";
	}

	get isCacheSafe(): boolean {
		return false;
	}

	async initialize(): Promise<void> {
		log.debug("Starting, ", this.serviceId);
		log.debug(
			"Infos from config: ",
			conf.get("info_extractor.spotify.client_id"),
			" ",
			conf.get("info_extractor.spotify.client_secret")
		);
	}

	isCollectionURL(link: string): boolean {
		if (parseSpotify(link)?.kind === "playlist") {
			return true;
		} else {
			return false;
		}
	}

	getVideoId(link: string): string {
		const parsed = parseSpotify(link);
		return parsed ? parsed.id : "";
	}

	canHandleURL(link: string): boolean {
		return parseSpotify(link) !== null;
	}

	async getAuthToken(clientid: string, clientsecret: string): Promise<SpotifyApiAnswer> {
		log.debug("Requesting Spotify access token");
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			client_id: clientid,
			client_secret: clientsecret,
		}).toString();

		const { data } = await axios.post<SpotifyApiAnswer>(SpotifyApiTokenURL, body, {
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			timeout: AXIOS_TIMEOUT_MS,
		});

		log.debug("Received token type:", data.token_type, "expires in:", data.expires_in);
		return data;
	}

	async getTrack(link: string, authtype: string, authtoken: string) {
		const id = this.getVideoId(link);
		log.debug("Fetching Spotify track with id:", id);
		const { data } = await axios.get<SpotifyAnswerTrack>(SpotifyApiTrackURL + id, {
			headers: { Authorization: `${authtype} ${authtoken}` },
			timeout: AXIOS_TIMEOUT_MS,
		});

		const bestimage = getBestImage(data.album.images);

		log.debug("Track fetched:", data.name, "by", data.artists.map(a => a.name).join(", "));
		return { title: data.name, artists: data.artists.map(a => a.name), cover: bestimage?.url };
	}

	async getPlaylist(link: string, authtype: string, authtoken: string) {
		const id = this.getVideoId(link);
		log.debug("Fetching Spotify playlist with id:", id);

		const { data } = await axios.get<SpotifyAnswerPlaylist>(SpotifyApiPlaylistURL + id, {
			headers: { Authorization: `${authtype} ${authtoken}` },
			timeout: AXIOS_TIMEOUT_MS,
		});

		const bestimage = getBestImage(data.images);

		const items = data.tracks.items
			.map(it => it.track)
			.filter(Boolean)
			.map(track => ({
				title: track.name,
				artists: track.artists.map(a => a.name),
				cover: getBestImage(track.album.images)?.url,
			}));

		log.debug("Playlist fetched:", data.name, "with", items.length, "items");
		return { name: data.name, cover: bestimage?.url, items };
	}

	async fetchVideoInfo(link: string): Promise<Video> {
        log.debug("fetchVideoInfo called with link:", link);
		const { token_type, access_token } = await this.getAuthToken(
			this.clientid,
			this.clientsecret
		);
		// Playlist
		if (this.isCollectionURL(link)) {
			const pl = await this.getPlaylist(link, token_type, access_token);
			const first = pl.items[0];
            log.debug("Playlist mode: using first track:", first.title);
			const url = await ytSearchUrl(buildYtQuery(first.title, first.artists));
			return {
				service: "youtube",
				id: url,
				title: first.title,
				thumbnail: first.cover ?? "",
			};
		}
        
		const tr = await this.getTrack(link, token_type, access_token);
        log.debug("Single track mode: found track:", tr.title);

		const url = await ytSearchUrl(buildYtQuery(tr.title, tr.artists));
        log.debug("YouTube search result url:", url);

		return {
			service: "youtube",
			id: url,
			title: tr.title,
			thumbnail: tr.cover ?? "",
		};
	}
}
