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

import * as Promise from 'bluebird';
import {HazelcastClient} from '../../HazelcastClient';
import {ClientMessage} from '../../protocol/ClientMessage';
import {UnsupportedOperationError} from '../../core';

/**
 * Common super class for any CP Subsystem proxy.
 * @internal
 */
export abstract class BaseCPProxy {

    protected client: HazelcastClient;
    protected readonly proxyName: string;
    protected readonly serviceName: string;

    constructor(client: HazelcastClient, serviceName: string, proxyName: string) {
        this.client = client;
        this.proxyName = proxyName;
        this.serviceName = serviceName;
    }

    getPartitionKey(): string {
        throw new UnsupportedOperationError('This operation is not supported by CP Subsystem');
    }

    getName(): string {
        return this.proxyName;
    }

    getServiceName(): string {
        return this.serviceName;
    }

    /**
     * Encodes a request from a codec and invokes it on any node.
     * @param codec
     * @param codecArguments
     * @returns response message
     */
    protected encodeInvokeOnRandomTarget(codec: any, ...codecArguments: any[]): Promise<ClientMessage> {
        const clientMessage = codec.encodeRequest(...codecArguments);
        return this.client.getInvocationService().invokeOnRandomTarget(clientMessage);
    }
}
