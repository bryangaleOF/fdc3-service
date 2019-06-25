/**
 * @module ContextChannels
 */

import {Identity} from 'openfin/_v2/main';

import {parseIdentity, parseContext, validateEnvironment, parseChannelId} from './validation';
import {tryServiceDispatch, getServicePromise} from './connection';
import {APIFromClientTopic, DesktopChannelTransport, ChannelTransport, APIToClientTopic, ChannelContextPayload} from './internal';
import {Context} from './context';
import {ContextListener} from './main';

export type ChannelId = string;

export type Channel = DesktopChannel|DefaultChannel;

/**
 * Event fired whenever a window changes channel. See {@link addEventListener}.
 *
 * This event can be used to track all channel changes, rather than listening only to a specific channel.
 *
 * @event
 */
export interface ChannelChangedEvent {
    type: 'channel-changed';

    /**
     * The window that has switched channel.
     */
    identity: Identity;

    /**
     * The channel that the window now belongs to.
     *
     * Will be `null` if the window has just been closed, and so is being removed from a channel without being added to
     * another.
     */
    channel: Channel|null;

    /**
     * The previous channel that the window belonged to.
     *
     * Will be `null` if the window has just been created, and so doesn't have a previous channel.
     */
    previousChannel: Channel|null;
}

interface ChannelContextListener extends ContextListener {
    id: ChannelId;
}

/**
 * Object representing a context channel.
 *
 * All interactions with a context channel happen through the methods on here.
 */
abstract class ChannelBase {
    /**
     * Constant that uniquely identifies this channel. Will be generated by the service, and guarenteed to be unique
     * within the set of channels registered with the service.
     *
     * In the case of `desktop` channels (see {@link DesktopChannel}), these IDs _should_ persist across sessions. The
     * channel list is defined by the service, but can be overridden by a desktop owner. If the desktop owner keeps
     * this list static (which is recommended), then IDs will also persist across sessions.
     */
    public readonly id: ChannelId;

    /**
     * Uniquely defines each channel type.
     *
     * See overrides of this class for list of allowed values.
     */
    public readonly type: string;

    protected constructor(id: string, type: string) {
        this.id = id;
        this.type = type;
    }

    /**
     * Returns a list of all windows belonging to the specified channel.
     *
     * If the window making the call is a member of this channel, it will be included in the results. If there are no
     * windows on this channel, an empty array is returned.
     */
    public async getMembers(): Promise<Identity[]> {
        return tryServiceDispatch(APIFromClientTopic.CHANNEL_GET_MEMBERS, {id: this.id});
    }

    /**
     * Returns the last context that was broadcast on this channel. All channels initially have no context, until a
     * window is added to the channel and then broadcasts. If there is not yet any context on the channel, this method
     * will return `null`. The context is also reset back into it's initial context-less state whenever a channel is
     * cleared of all windows.
     *
     * The context of a channel will be captured regardless of how the context is broadcasted on this channel - whether
     * using the top-level FDC3 `broadcast` function, or using the channel-level {@link broadcast} function on this
     * object.
     *
     * NOTE: Only non-default channels are stateful, for the default channel this method will always return `null`.
     */
    public async getCurrentContext(): Promise<Context|null> {
        return tryServiceDispatch(APIFromClientTopic.CHANNEL_GET_CURRENT_CONTEXT, {id: this.id});
    }

    /**
     * Adds the given window to this channel. If no identity is provided, the window making the call will be the window
     * added to the channel.
     *
     * If the channel has a current context (see {@link getCurrentContext}) then that context will be immediately passed to
     * the given window upon joining the channel, via its context listener(s).
     *
     * Note that all windows will always belong to exactly one channel at all times. If you wish to leave a channel,
     * the only way to do so is to join another channel. A window may rejoin the default channel by calling `channels.defaultChannel.join()`.
     *
     * @param identity The window that should be added to this channel. If omitted, will use the window that calls this method.
     * @throws `TypeError`: If `identity` is not a valid {@link https://developer.openfin.co/docs/javascript/stable/global.html#Identity | Identity}
     * @throws `FDC3Error`: If the window specified by `identity` does not exist
     * @throws `FDC3Error`: If the window specified by `identity` does not integrate FDC3 (determined by inclusion of the client API module)
     */
    public async join(identity?: Identity): Promise<void> {
        return tryServiceDispatch(APIFromClientTopic.CHANNEL_JOIN, {id: this.id, identity: identity && parseIdentity(identity)});
    }

    /**
     * Broadcasts the given context on this channel.
     *
     * Note that this function can be used without first joining the channel, allowing applications to broadcast on
     * channels that they aren't a member of.
     *
     * This broadcast will be received by all windows that are members of this channel, *except* for the window that
     * makes the broadcast. This matches the behaviour of the top-level FDC3 `broadcast` function.
     *
     * @param context The context to broadcast to all windows on this channel
     * @throws `TypeError`: If `context` is not a valid {@link Context}
     */
    public async broadcast(context: Context): Promise<void> {
        return tryServiceDispatch(APIFromClientTopic.CHANNEL_BROADCAST, {id: this.id, context: parseContext(context)});
    }

    /**
     * Event that is fired whenever a window broadcasts on this channel.
     *
     * This can be triggered by a window belonging to the channel calling the top-level FDC3 `broadcast` function, or by
     * any window calling this channel's {@link Channel.broadcast} method.
     *
     * @param handler Function that should be called whenever a context is broadcast on this channel
     */
    public async addContextListener(handler: (context: Context) => void): Promise<ContextListener> {
        validateEnvironment();

        const listener: ChannelContextListener = {
            id: this.id,
            handler,
            unsubscribe: async () => {
                const index: number = channelContextListeners.indexOf(listener);

                if (index >= 0) {
                    channelContextListeners.splice(index, 1);

                    if (!hasChannelContextListener(this.id)) {
                        await tryServiceDispatch(APIFromClientTopic.CHANNEL_REMOVE_CONTEXT_LISTENER, {id: this.id});
                    }
                }

                return index >= 0;
            }
        };

        const hasContextListenerBefore = hasChannelContextListener(this.id);
        channelContextListeners.push(listener);

        if (!hasContextListenerBefore) {
            await tryServiceDispatch(APIFromClientTopic.CHANNEL_ADD_CONTEXT_LISTENER, {id: this.id});
        }
        return listener;
    }
}

/**
 * User-facing channels, to display within a color picker or channel selector component.
 *
 * This list of channels should be considered fixed by applications - the service will own the list of user channels,
 * making the same list of channels available to all applications, and this list will not change over the lifecycle of
 * the service.
 *
 * We do not intend to support creation of 'user' channels at runtime, as this would add considerable complexity when
 * implementing a channel selector component, as it would need to support a dynamic channel list
 */
export class DesktopChannel extends ChannelBase {
    public readonly type!: 'desktop';

    /**
     * A user-readable name for this channel, e.g: `"Red"`
     */
    public readonly name: string;

    /**
     * The color that should be associated within this channel when displaying this channel in a UI, e.g: `0xFF0000`.
     */
    public readonly color: number;

    /**
     * @hidden
     */
    public constructor(transport: DesktopChannelTransport) {
        super(transport.id, 'desktop');

        this.name = transport.name;
        this.color = transport.color;
    }
}

/**
 * All windows will start off in this channel.
 *
 * Unlike desktop channels, the default channel has no pre-defined name or visual style. It is up to apps to display
 * this in the channel selector as they see fit - it could be as "default", or "none", or by "leaving" a user channel.
 */
export class DefaultChannel extends ChannelBase {
    public readonly type!: 'default';

    /**
     * @hidden
     */
    public constructor() {
        super(DEFAULT_CHANNEL_ID, 'default');
    }
}

/**
 * @hidden
 */
export const DEFAULT_CHANNEL_ID: ChannelId = 'default';

/**
 * The channel in which all windows will initially be placed.
 *
 * All windows will belong to exactly one channel at all times. If they have not explicitly
 * been placed into a channel via a {@link Channel.join} call, they will be in this channel.
 *
 * If an app wishes to leave a desktop channel it can do so by (re-)joining this channel.
 */
export const defaultChannel: DefaultChannel = new DefaultChannel();

const channelLookup: {[id: string]: Channel} = {
    [DEFAULT_CHANNEL_ID]: defaultChannel
};

const channelContextListeners: ChannelContextListener[] = [];

/**
 * Gets all user-visible channels.
 *
 * This is the list of channels that should be used to populate a channel selector. All channels returned will have
 * additional metadata that can be used to populate a selector UI with a consistent cross-app channel list.
 */
export async function getDesktopChannels(): Promise<DesktopChannel[]> {
    const channelTransports = await tryServiceDispatch(APIFromClientTopic.GET_DESKTOP_CHANNELS, {});

    return channelTransports.map(getChannelObject) as DesktopChannel[];
}

/**
 * Fetches a channel object for a given channel identifier. The `channelId` property maps to the {@link Channel.id} field.
 *
 * @param channelId The ID of the channel to return
 * @throws `TypeError`: If `channelId` is not a valid ChannelId
 * @throws `FDC3Error`: If the channel specified by `channelId` does not exist
 */
export async function getChannelById(channelId: ChannelId): Promise<Channel> {
    const channelTransport = await tryServiceDispatch(APIFromClientTopic.GET_CHANNEL_BY_ID, {id: parseChannelId(channelId)});

    return getChannelObject(channelTransport);
}

/**
 * Returns the channel that the current window is assigned to.
 *
 * @param identity The window to query. If omitted, will use the window that calls this method.
 * @throws `TypeError`: If `identity` is not a valid {@link https://developer.openfin.co/docs/javascript/stable/global.html#Identity | Identity}
 * @throws `FDC3Error`: If the window specified by `identity` does not exist
 * @throws `FDC3Error`: If the window specified by `identity` does not integrate FDC3 (determined by inclusion of the client API module)
 */
export async function getCurrentChannel(identity?: Identity): Promise<Channel> {
    const channelTransport = await tryServiceDispatch(APIFromClientTopic.GET_CURRENT_CHANNEL, {identity: identity && parseIdentity(identity)});

    return getChannelObject(channelTransport);
}

/**
 * @hidden
 */
export function getChannelObject<T extends Channel = Channel>(channelTransport: ChannelTransport): T {
    let channel: Channel = channelLookup[channelTransport.id];

    if (!channel) {
        switch (channelTransport.type) {
            case 'default':
                channel = defaultChannel;
                break;
            case 'desktop':
                channel = new DesktopChannel(channelTransport as DesktopChannelTransport);
                channelLookup[channelTransport.id] = channel;
        }
    }

    return channel as T;
}

function hasChannelContextListener(id: ChannelId) {
    return channelContextListeners.some(listener => listener.id === id);
}

if (typeof fin !== 'undefined') {
    getServicePromise().then(channelClient => {
        channelClient.register(APIToClientTopic.CHANNEL_CONTEXT, (payload: ChannelContextPayload) => {
            channelContextListeners.forEach((listener: ChannelContextListener) => {
                if (listener.id === payload.channel) {
                    listener.handler(payload.context);
                }
            });
        });
    }, reason => {
        console.warn('Unable to register client channel context handlers. getServicePromise() rejected with reason:', reason);
    });
}
