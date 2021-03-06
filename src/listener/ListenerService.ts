/*
 * Copyright (c) 2008-2020, Hazelcast, Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** @ignore *//** */

import {HazelcastClient} from '../HazelcastClient';
import {
    ClientNotActiveError,
    HazelcastError,
    IOError,
    TargetDisconnectedError
} from '../core';
import {ClientConnection} from '../network/ClientConnection';
import {ClientEventRegistration} from '../invocation/ClientEventRegistration';
import {Invocation} from '../invocation/InvocationService';
import {RegistrationKey} from '../invocation/RegistrationKey';
import {ClientMessageHandler} from '../protocol/ClientMessage';
import {ListenerMessageCodec} from './ListenerMessageCodec';
import {deferredPromise} from '../util/Util';
import {UuidUtil} from '../util/UuidUtil';
import {ILogger} from '../logging/ILogger';

/** @internal */
export class ListenerService {

    private client: HazelcastClient;
    private logger: ILogger;
    private isSmartService: boolean;

    private activeRegistrations: Map<string, Map<ClientConnection, ClientEventRegistration>>;
    private userKeyInformation: Map<string, RegistrationKey>;

    constructor(client: HazelcastClient) {
        this.client = client;
        this.logger = this.client.getLoggingService().getLogger();
        this.isSmartService = this.client.getConfig().network.smartRouting;
        this.activeRegistrations = new Map();
        this.userKeyInformation = new Map();
    }

    start(): void {
        this.client.getConnectionManager().on('connectionAdded', this.onConnectionAdded.bind(this));
        this.client.getConnectionManager().on('connectionRemoved', this.onConnectionRemoved.bind(this));
    }

    onConnectionAdded(connection: ClientConnection): void {
        this.reregisterListenersOnConnection(connection);
    }

    onConnectionRemoved(connection: ClientConnection): void {
        this.removeRegistrationsOnConnection(connection);
    }

    reregisterListenersOnConnection(connection: ClientConnection): void {
        this.activeRegistrations.forEach((registrationMap, userKey) => {
            if (registrationMap.has(connection)) {
                return;
            }
            this.invokeRegistrationFromRecord(userKey, connection).then((eventRegistration) => {
                // handle potential race with deregisterListener
                // which might have deleted the registration
                if (this.userKeyInformation.get(userKey) === undefined) {
                    this.deregisterListenerOnTarget(userKey, eventRegistration);
                    return;
                }
                registrationMap.set(connection, eventRegistration);
            }).catch((err) => {
                this.logger.warn('ListenerService', err);
            });
        }, this);
    }

    removeRegistrationsOnConnection(connection: ClientConnection): void {
        this.activeRegistrations.forEach((registrationsOnUserKey) => {
            const eventRegistration = registrationsOnUserKey.get(connection);
            if (eventRegistration !== undefined) {
                this.client.getInvocationService().removeEventHandler(eventRegistration.correlationId);
            }
        });
    }

    invokeRegistrationFromRecord(userKey: string, connection: ClientConnection): Promise<ClientEventRegistration> {
        const deferred = deferredPromise<ClientEventRegistration>();
        const activeRegsOnUserKey = this.activeRegistrations.get(userKey);
        if (activeRegsOnUserKey !== undefined && activeRegsOnUserKey.has(connection)) {
            deferred.resolve(activeRegsOnUserKey.get(connection));
            return deferred.promise;
        }
        const registrationKey = this.userKeyInformation.get(userKey);
        // New correlation id will be set on the invoke call
        const registerRequest = registrationKey.getRegisterRequest().copyWithNewCorrelationId();
        const codec = registrationKey.getCodec();
        const invocation = new Invocation(this.client, registerRequest);
        invocation.handler = registrationKey.getHandler() as any;
        invocation.connection = connection;
        this.client.getInvocationService().invokeUrgent(invocation).then((responseMessage) => {
            const correlationId = responseMessage.getCorrelationId();
            const response = codec.decodeAddResponse(responseMessage);
            const eventRegistration = new ClientEventRegistration(response, correlationId, invocation.connection, codec);
            this.logger.debug('ListenerService',
                'Listener ' + userKey + ' re-registered on ' + connection.toString());

            deferred.resolve(eventRegistration);
        }).catch(((err) => {
            deferred.reject(new HazelcastError('Could not add listener[' + userKey +
                '] to connection[' + connection.toString() + ']', err));
        }));
        return deferred.promise;
    }

    registerListener(codec: ListenerMessageCodec,
                     listenerHandlerFn: ClientMessageHandler): Promise<string> {
        const activeConnections = this.client.getConnectionManager().getActiveConnections();
        const userKey = UuidUtil.generate().toString();
        let connectionsOnUserKey: Map<ClientConnection, ClientEventRegistration>;
        const deferred = deferredPromise<string>();
        const registerRequest = codec.encodeAddRequest(this.isSmart());
        connectionsOnUserKey = this.activeRegistrations.get(userKey);
        if (connectionsOnUserKey === undefined) {
            connectionsOnUserKey = new Map();
            this.activeRegistrations.set(userKey, connectionsOnUserKey);
            this.userKeyInformation.set(userKey,
                new RegistrationKey(userKey, codec, registerRequest, listenerHandlerFn));
        }
        for (const connection of activeConnections) {
            if (connectionsOnUserKey.has(connection)) {
                continue;
            }
            // new correlation id will be set on the invoke call
            const requestCopy = registerRequest.copyWithNewCorrelationId();
            const invocation = new Invocation(this.client, requestCopy);
            invocation.handler = listenerHandlerFn as any;
            invocation.connection = connection;
            this.client.getInvocationService().invokeUrgent(invocation).then((responseMessage) => {
                const correlationId = responseMessage.getCorrelationId();
                const response = codec.decodeAddResponse(responseMessage);
                const clientEventRegistration = new ClientEventRegistration(
                    response, correlationId, invocation.connection, codec);
                this.logger.debug('ListenerService',
                    'Listener ' + userKey + ' registered on ' + invocation.connection.toString());
                connectionsOnUserKey.set(connection, clientEventRegistration);
            }).then(() => {
                deferred.resolve(userKey);
            }).catch((err) => {
                if (invocation.connection.isAlive()) {
                    this.deregisterListener(userKey)
                        .catch(() => {
                            // no-op
                        });
                    deferred.reject(new HazelcastError('Listener cannot be added!', err));
                }
            });
        }
        return deferred.promise;
    }

    deregisterListener(userKey: string): Promise<boolean> {
        const deferred = deferredPromise<boolean>();
        const registrationsOnUserKey = this.activeRegistrations.get(userKey);
        if (registrationsOnUserKey === undefined) {
            deferred.resolve(false);
            return deferred.promise;
        }

        this.activeRegistrations.delete(userKey);
        this.userKeyInformation.delete(userKey);

        registrationsOnUserKey.forEach((eventRegistration, connection) => {
            // remove local handler
            registrationsOnUserKey.delete(connection);
            this.client.getInvocationService().removeEventHandler(eventRegistration.correlationId);
            // the rest is for deleting remote registration
            this.deregisterListenerOnTarget(userKey, eventRegistration);
        });

        deferred.resolve(true);
        return deferred.promise;
    }

    /**
     * Asynchronously de-registers listener on the target associated
     * with the given event registration.
     */
    private deregisterListenerOnTarget(userKey: string,
                                       eventRegistration: ClientEventRegistration): void {
        const clientMessage = eventRegistration.codec.encodeRemoveRequest(eventRegistration.serverRegistrationId);
        // null message means no remote registration (e.g. for backup acks)
        if (clientMessage === null) {
            return;
        }
        const invocation = new Invocation(this.client, clientMessage, Number.MAX_SAFE_INTEGER);
        invocation.connection = eventRegistration.subscriber;
        this.client.getInvocationService().invoke(invocation).catch((err) => {
            if (err instanceof ClientNotActiveError
                    || err instanceof IOError
                    || err instanceof TargetDisconnectedError) {
                return;
            }
            this.logger.warn('ListenerService',
                'Deregistration of listener ' + userKey + ' has failed for address '
                    + invocation.connection.getRemoteAddress().toString());
        });
    }

    isSmart(): boolean {
        return this.isSmartService;
    }
}
