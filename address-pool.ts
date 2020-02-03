import { InMemorySigner } from '@taquito/signer';
import { TezosToolkit } from '@taquito/taquito';
import { b58cencode, prefix, Prefix } from '@taquito/utils';
import { logger } from './logger';
import { keyValue } from './storage/key-value';
import { RedisQueue } from "./storage/redis-queue";
import { RedisClient } from 'redis';
import { RemoteSigner } from '@taquito/remote-signer';
import { getKeyProducedCounter } from './metrics/keys-produced.counter';
import { getKeyIssuedCounter } from './metrics/keys-issued.counter';

const crypto = require('crypto');

export interface PoolConfig {
  redisListName: string;
  rpcUrl: string;
  targetBuffer: number;
  tzAmount: number;
  batchSize: number;
  lastJobKey: string;
  funderPKH: string;
  remoteSignerUrl: string;
}

export class AddressPool {

  queue: RedisQueue;

  constructor(
    public readonly id: string,
    private config: PoolConfig,
    client: RedisClient
  ) {
    this.queue = new RedisQueue(client, config.redisListName);
  }

  public async taquito() {
    const tezos = new TezosToolkit()
    tezos.setProvider({ rpc: this.config.rpcUrl, signer: new RemoteSigner(this.config.funderPKH, this.config.remoteSignerUrl, {}) })
    return tezos;
  }

  async getFundingBalance() {
    const Tezos = await this.taquito();
    return (await Tezos.tz.getBalance(await Tezos.signer.publicKeyHash())).toString()
  }

  async pop() {
    const result = await this.queue.pop();

    setTimeout(() => {
      // tslint:disable-next-line: no-floating-promises
      this.generateKeys()
    })

    if (result) {
      getKeyIssuedCounter(this.id).inc();
    }

    return result;
  }

  async size() {
    return this.queue.size();
  }

  private async generateKeys() {
    try {
      const Tezos = await this.taquito()
      const { level } = await Tezos.rpc.getBlockHeader()

      if (await this.queue.size() < this.config.targetBuffer && (!keyValue.has(this.config.lastJobKey) || keyValue.get(this.config.lastJobKey) < level)) {
        logger.info('Generating new keys...')
        keyValue.put(this.config.lastJobKey, level);
        const dests: { key: string, pkh: string }[] = [];

        for (let i = 0; i < this.config.batchSize; i++) {
          const keyBytes = Buffer.alloc(32);
          crypto.randomFillSync(keyBytes)

          const key = b58cencode(new Uint8Array(keyBytes), prefix[Prefix.P2SK]);
          const pkh = await new InMemorySigner(key).publicKeyHash();
          dests.push({ key, pkh });
        }

        const batch = Tezos.batch()
        dests.forEach(({ pkh }) => {
          batch.withTransfer({ to: pkh, amount: this.config.tzAmount });
        })

        const op = await batch.send();
        await op.confirmation();

        for (const { key } of dests) {
          await this.queue.push(key);
        }

        getKeyProducedCounter(this.id).inc(this.config.batchSize)
        logger.info('New batch generated')
      }
    } catch (ex) {
      logger.error(ex.message);
    }
  }
}
