// Real mainnet transactions for the account recorder's tests (plan 028-6), fetched from FastNEAR
// on 2026-10-18 and trimmed to the fields the recorder reads. Call arguments are kept only on
// the vault's receipts.
//
// Attribution: see ATTRIBUTIONS.md #21 (FastNEAR transaction API).

import type { FastNearTx } from "@/features/vault/lib/vault-history-client";

/** pablofork.near deposits nBTC from its wallet: one `mt_mint` (memo `deposit`). */
export const DEPOSIT: FastNearTx = {
  "transaction": {
    "hash": "67p7kFmHWXsddHomYKthabbG7Rtqxy2fjn3KxFuVMS5m",
    "signer_id": "pablofork.near",
    "receiver_id": "nbtc.bridge.near"
  },
  "execution_outcome": {
    "block_height": 219728344,
    "block_timestamp": 1791842470959510000,
    "outcome": {
      "receipt_ids": [
        "Eytj7hhwimrgmAbsmD6znREukidhjWooZbzD5WtQMKLo"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "Eytj7hhwimrgmAbsmD6znREukidhjWooZbzD5WtQMKLo",
        "block_height": 219728345,
        "block_timestamp": 1791842471552192800,
        "outcome": {
          "executor_id": "nbtc.bridge.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intents.near\",\"amount\":\"14170\"}]}"
          ],
          "status": {
            "SuccessReceiptId": "8PgrhgXouxHAqz3cNEhWUHyHbCVD1zZu5vMcm626eRW3"
          },
          "receipt_ids": [
            "4h9nMn9NK5HqbBtH99e8no5m7ge6HFu2syS6KuE4YCFM",
            "8PgrhgXouxHAqz3cNEhWUHyHbCVD1zZu5vMcm626eRW3",
            "qHfZKnGi8aiDvxLGuUCP4wr8jxhgESdeFvNdpRUhLnm"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "4h9nMn9NK5HqbBtH99e8no5m7ge6HFu2syS6KuE4YCFM",
        "block_height": 219728346,
        "block_timestamp": 1791842472138179800,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\",\"data\":[{\"owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:nbtc.bridge.near\"],\"amounts\":[\"14170\"],\"memo\":\"deposit\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "4L3hmES6WK1j2dPH8TSH9cN2jiMDVAovHzCVTB28NSeA"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "qHfZKnGi8aiDvxLGuUCP4wr8jxhgESdeFvNdpRUhLnm",
        "block_height": 219728346,
        "block_timestamp": 1791842472138179800,
        "outcome": {
          "executor_id": "pablofork.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "4L3hmES6WK1j2dPH8TSH9cN2jiMDVAovHzCVTB28NSeA",
        "block_height": 219728347,
        "block_timestamp": 1791842472876561200,
        "outcome": {
          "executor_id": "pablofork.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "8PgrhgXouxHAqz3cNEhWUHyHbCVD1zZu5vMcm626eRW3",
        "block_height": 219728347,
        "block_timestamp": 1791842472876561200,
        "outcome": {
          "executor_id": "nbtc.bridge.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "DaE57y1CC6dMjzisCsawvXTLHcrVidpPd8zjGScsHycM"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "DaE57y1CC6dMjzisCsawvXTLHcrVidpPd8zjGScsHycM",
        "block_height": 219728348,
        "block_timestamp": 1791842473428601600,
        "outcome": {
          "executor_id": "pablofork.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** pablofork.near withdraws USDT to its wallet: `ft_withdraw` + `mt_burn` (memo `withdraw`). */
export const WITHDRAWAL: FastNearTx = {
  "transaction": {
    "hash": "3rhK3x3uvJ9dN9RJRhWm3PhT52WuT9X12EUaMkZXdecp",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 218019670,
    "block_timestamp": 1790833234004072000,
    "outcome": {
      "receipt_ids": [
        "7NaPtqSeYbyqFyDZN27LT74s2Mr8fGX6qa5wpCyneBoC"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "7NaPtqSeYbyqFyDZN27LT74s2Mr8fGX6qa5wpCyneBoC",
        "block_height": 218019670,
        "block_timestamp": 1790833234004072000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"ft_withdraw\",\"data\":[{\"intent_hash\":\"EpqKNvqdFcrNS2g6aLqSWFN6RWe92a65jzc3WVQFgvKj\",\"account_id\":\"pablofork.near\",\"token\":\"usdt.tether-token.near\",\"receiver_id\":\"pablofork.near\",\"amount\":\"500000\",\"min_gas\":\"17050000000000\"}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"EpqKNvqdFcrNS2g6aLqSWFN6RWe92a65jzc3WVQFgvKj\",\"account_id\":\"pablofork.near\",\"nonce\":\"oxvIopSxk4+pPghegYv+ANdpt6YT7Wed8AND3xcG4tI=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"500000\"],\"memo\":\"withdraw\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "ExEFezaLW2agHqBDybHeE6U8m8r9NKWaWMVnm52oAu3D",
            "5uLgeci4GnrHK3aX3dzovARS4x4vcxmCZk8MfAd9Has1",
            "3zw4ZihwgFQdEAHLfitDjZ3bNjXzswbNGkDWLjhX1YKv"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3zw4ZihwgFQdEAHLfitDjZ3bNjXzswbNGkDWLjhX1YKv",
        "block_height": 218019671,
        "block_timestamp": 1790833234527096600,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "ExEFezaLW2agHqBDybHeE6U8m8r9NKWaWMVnm52oAu3D",
        "block_height": 218019671,
        "block_timestamp": 1790833234527096600,
        "outcome": {
          "executor_id": "usdt.tether-token.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"intents.near\",\"new_owner_id\":\"pablofork.near\",\"amount\":\"500000\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "8PW2obS74BF7HRLvARD5omzUeMUTyVDyujZWbmrxXznQ"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "8PW2obS74BF7HRLvARD5omzUeMUTyVDyujZWbmrxXznQ",
        "block_height": 218019672,
        "block_timestamp": 1790833235007472000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "5uLgeci4GnrHK3aX3dzovARS4x4vcxmCZk8MfAd9Has1",
        "block_height": 218019672,
        "block_timestamp": 1790833235007472000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "4d3UaCmz9vKDHmW6SJr4JHnUeGvu1GTEM1HiskcbL9Mc"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "4d3UaCmz9vKDHmW6SJr4JHnUeGvu1GTEM1HiskcbL9Mc",
        "block_height": 218019673,
        "block_timestamp": 1790833235520103200,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** pablofork.near signs a `transfer` of nBTC to a 64-hex account (a 1Click deposit address). */
export const TRANSFER_HEX: FastNearTx = {
  "transaction": {
    "hash": "CQvxeGe9aRHnXnM51c1UNbfQgrgvfnBPJMGqKUHLG7Gr",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 219728675,
    "block_timestamp": 1791842669959029500,
    "outcome": {
      "receipt_ids": [
        "5MtGSzUsNvxwBVH8zMvV97DgTvKcBjig8MbKwGm3Hznv"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "5MtGSzUsNvxwBVH8zMvV97DgTvKcBjig8MbKwGm3Hznv",
        "block_height": 219728675,
        "block_timestamp": 1791842669959029500,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"9kHf3MDWot2MymZeyDreKU15naGiz5gLPK74PtN6yyMw\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa\",\"tokens\":{\"nep141:nbtc.bridge.near\":\"14170\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"9kHf3MDWot2MymZeyDreKU15naGiz5gLPK74PtN6yyMw\",\"account_id\":\"pablofork.near\",\"nonce\":\"rkFcgdYxhz+r+BGkKoCt9RL0vkrVgfDudQYnzrop+Nc=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"b3d8e1c1307a4cc180501e170a7bef826380917cd0c4453d937b2ba3085428aa\",\"token_ids\":[\"nep141:nbtc.bridge.near\"],\"amounts\":[\"14170\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "DgWTpavzLWExdCmWKEfkZJESmBY9H9eopoNbfW31BZja"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "DgWTpavzLWExdCmWKEfkZJESmBY9H9eopoNbfW31BZja",
        "block_height": 219728676,
        "block_timestamp": 1791842670648392000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** A 1Click swap of SOMEONE ELSE that withdraws USDT to pablofork.near: only `ft_withdraw`'s `receiver_id` names it; no movement of its own. */
export const RECEIVED_WITHDRAWAL: FastNearTx = {
  "transaction": {
    "hash": "84zJ93hrB4H4oaaNYqBxme916PS99eqSyrnybG27SMYv",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 218873996,
    "block_timestamp": 1791338573479976000,
    "outcome": {
      "receipt_ids": [
        "GvKXTnFicZ6WbKG9WFWfewNyXcPWT9f2FmzxfytsWJXC"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "GvKXTnFicZ6WbKG9WFWfewNyXcPWT9f2FmzxfytsWJXC",
        "block_height": 218873996,
        "block_timestamp": 1791338573479976000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"7PvgFgzhJqPG6fthhC221BJi7JENUFAufd6LCsi5WewM\",\"account_id\":\"kipseli.near\",\"diff\":{\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\":\"999899\",\"nep141:usdt.tether-token.near\":\"-1000035\"},\"fees_collected\":{\"nep141:usdt.tether-token.near\":\"2\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"6qF9ydg4C218i89vVxV1KGW9uPX1hFcRxpwVwut2GjeV\",\"account_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"diff\":{\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\":\"-999900\",\"nep141:usdt.tether-token.near\":\"1000033\"},\"referral\":\"1click-unknown\",\"fees_collected\":{\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\":\"1\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"6qF9ydg4C218i89vVxV1KGW9uPX1hFcRxpwVwut2GjeV\",\"account_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"receiver_id\":\"143f2bb439575c286f4f585163f0e5fb4e464f8ce57ec06ae80741407d3cfb31\",\"tokens\":{\"nep141:usdt.tether-token.near\":\"167\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"6qF9ydg4C218i89vVxV1KGW9uPX1hFcRxpwVwut2GjeV\",\"account_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"receiver_id\":\"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd\",\"tokens\":{\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\":\"100\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"ft_withdraw\",\"data\":[{\"intent_hash\":\"6qF9ydg4C218i89vVxV1KGW9uPX1hFcRxpwVwut2GjeV\",\"account_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"token\":\"usdt.tether-token.near\",\"receiver_id\":\"pablofork.near\",\"amount\":\"999866\",\"min_gas\":\"17050000000000\"}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"7PvgFgzhJqPG6fthhC221BJi7JENUFAufd6LCsi5WewM\",\"account_id\":\"kipseli.near\",\"nonce\":\"KXNaTZnrtZ7BVrTO2MDK8N0GPTVWzLA0bVBNpZ/CvY8=\"},{\"intent_hash\":\"6qF9ydg4C218i89vVxV1KGW9uPX1hFcRxpwVwut2GjeV\",\"account_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"nonce\":\"Vij2xgAlKBKzQP7c1Rod3Bh5T04N+scrzVzuuCb7cHw=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\"],\"amounts\":[\"1\"]},{\"old_owner_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"new_owner_id\":\"kipseli.near\",\"token_ids\":[\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\"],\"amounts\":[\"999899\"]},{\"old_owner_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"new_owner_id\":\"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd\",\"token_ids\":[\"nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near\"],\"amounts\":[\"100\"]},{\"old_owner_id\":\"kipseli.near\",\"new_owner_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"999866\"]},{\"old_owner_id\":\"kipseli.near\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"2\"]},{\"old_owner_id\":\"kipseli.near\",\"new_owner_id\":\"143f2bb439575c286f4f585163f0e5fb4e464f8ce57ec06ae80741407d3cfb31\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"167\"]}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"c27e438d67f794f634e2deee35366ec4079f7bb1ef0ecd9788ca1f36e1f25165\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"999866\"],\"memo\":\"withdraw\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "B2sxhoVdcHtXgLdmqdRNu5jt7abR9xLBKqmHKRqKEFAy",
            "27yCvVGQk9mASej4TE2HkanPXnUp6rsxXNd6cTDyhCjF",
            "Bos221w3tCYmHMY94GrZNfGHwt3cnR8QGCSnuo79W42p"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "Bos221w3tCYmHMY94GrZNfGHwt3cnR8QGCSnuo79W42p",
        "block_height": 218873997,
        "block_timestamp": 1791338574093368000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "B2sxhoVdcHtXgLdmqdRNu5jt7abR9xLBKqmHKRqKEFAy",
        "block_height": 218873997,
        "block_timestamp": 1791338574093368000,
        "outcome": {
          "executor_id": "usdt.tether-token.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"intents.near\",\"new_owner_id\":\"pablofork.near\",\"amount\":\"999866\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "25Amj8bFtL23o8pJUz6PCiF68kf5zgBvG8gYcZ6Gpkv1"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "25Amj8bFtL23o8pJUz6PCiF68kf5zgBvG8gYcZ6Gpkv1",
        "block_height": 218873998,
        "block_timestamp": 1791338574736326100,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "27yCvVGQk9mASej4TE2HkanPXnUp6rsxXNd6cTDyhCjF",
        "block_height": 218873998,
        "block_timestamp": 1791338574736326100,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "Gx4MnWf8PTdBzkCrpUc6LTp3o3fyDvrgU9x4yUnGtnhs"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "Gx4MnWf8PTdBzkCrpUc6LTp3o3fyDvrgU9x4yUnGtnhs",
        "block_height": 218873999,
        "block_timestamp": 1791338575415546400,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** intentfolio-vault.near pays a withdrawal from a portfolio back to pablofork.near: an INCOMING `mt_transfer` (no movement of its own) and the vault's `unallocate`. */
export const UNALLOCATE: FastNearTx = {
  "transaction": {
    "hash": "82zCvEdjEDPg49ygj8snG72SwkfyqL53Z7S9hi3LLQWH",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 218019868,
    "block_timestamp": 1790833348995105800,
    "outcome": {
      "receipt_ids": [
        "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv",
        "block_height": 218019869,
        "block_timestamp": 1790833349662127400,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"pending_unallocation_opened\",\"data\":[{\"commit_id\":\"83f32a1de80d0f05a77e131fcaf7b301caf7ea2891d8eb9ee83ebf32ab74641f\",\"legs\":[[\"p_000000000000\",\"nep141:usdt.tether-token.near\",\"2457698\"]]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "3D5M8kJ4S2LZ8CQPEdHSTob4mb6YdUVKe1RJivN9TTvz",
            "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
            "7y9MGih1Hy9iW4XKNXbUHzJqm1Mc54rsPKAVJ1RRcEyA"
          ]
        }
      },
      "receipt": {
        "receipt_id": "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "commit_portfolio_changes",
                  "args": "eyJwYXlsb2FkIjp7InN0YW5kYXJkIjoibmVwNDEzIiwicGF5bG9hZCI6eyJtZXNzYWdlIjoie1wic2lnbmVyX2lkXCI6XCJwYWJsb2ZvcmsubmVhclwiLFwiZGVhZGxpbmVcIjpcIjIwMjYtMTAtMDFUMDU6NTI6MjMuMDAwWlwiLFwicG9ydGZvbGlvX2lkXCI6XCJwXzAwMDAwMDAwMDAwMFwiLFwidGFyZ2V0X2NoYW5nZXNcIjpbXSxcInRva2VuX2FkZGl0aW9uc1wiOltdLFwidG9rZW5fcmVtb3ZhbHNcIjpbXSxcInVuYWxsb2NhdGlvbnNcIjpbW1wibmVwMTQxOnVzZHQudGV0aGVyLXRva2VuLm5lYXJcIixcIjI0NTc2OThcIl1dfSIsIm5vbmNlIjoiVmlqMnhnQUFBQUFBQUNZNm9QdFIyaGpyZXBCV2RpK3FYbDZxL09NcWxHYz0iLCJyZWNpcGllbnQiOiJpbnRlbnRmb2xpby12YXVsdC5uZWFyIn0sInB1YmxpY19rZXkiOiJlZDI1NTE5OjJFVmd5SHlSWlpVV3JmZmVMcmloWUI4dkZMV2Z3UXZlNk1BNWVpV2FVZnhWIiwic2lnbmF0dXJlIjoiZWQyNTUxOTo1RkNUcm5ldndkRFFwdE14bTZjNUJMSjk1U25mbzQxdnZZdkxtYnNQaDV2YnVkdldSVlJBaFZGQ3hLaGVXMkp6bkszWVoyRUwxdE1iUkdKWmNTelk2YXdDIn19",
                  "gas": 300000000000000,
                  "deposit": "0"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3D5M8kJ4S2LZ8CQPEdHSTob4mb6YdUVKe1RJivN9TTvz",
        "block_height": 218019870,
        "block_timestamp": 1790833350128070400,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"intentfolio-vault.near\",\"new_owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"2457698\"],\"memo\":\"83f32a1de80d0f05a77e131fcaf7b301caf7ea2891d8eb9ee83ebf32ab74641f\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "A5STyAU6VZdaCTyEehcX9j5tGXWo1v7NG7yUeouHS4qp"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "7y9MGih1Hy9iW4XKNXbUHzJqm1Mc54rsPKAVJ1RRcEyA",
        "block_height": 218019870,
        "block_timestamp": 1790833350128070400,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "A5STyAU6VZdaCTyEehcX9j5tGXWo1v7NG7yUeouHS4qp",
        "block_height": 218019871,
        "block_timestamp": 1790833350837379800,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
        "block_height": 218019871,
        "block_timestamp": 1790833350837379800,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"unallocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"2457698\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "2yvu4cdtvYwWKkHCMtwPKfHd8xoPBPZAv3LkNmLYj6Na"
          ]
        }
      },
      "receipt": {
        "receipt_id": "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "on_unallocate_resolved",
                  "args": "eyJjb21taXRfaWQiOiI4M2YzMmExZGU4MGQwZjA1YTc3ZTEzMWZjYWY3YjMwMWNhZjdlYTI4OTFkOGViOWVlODNlYmYzMmFiNzQ2NDFmIn0=",
                  "gas": 152209616834544,
                  "deposit": "0"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "2yvu4cdtvYwWKkHCMtwPKfHd8xoPBPZAv3LkNmLYj6Na",
        "block_height": 218019872,
        "block_timestamp": 1790833351457021400,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** A relayed allocation whose `intents.near` receipt FAILED: its `transfer` line must not be stored. */
export const FAILED_TRANSFER: FastNearTx = {
  "transaction": {
    "hash": "CMvs2N29AEjCXXJWSymYrdmF1dsDvER8ct4qRDj3FFFM",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 216684337,
    "block_timestamp": 1790028248871062300,
    "outcome": {
      "receipt_ids": [
        "F7k88Dj4uRgChaXjhxyciBaGKNBrsgUJ8h6JhU1HrCSC"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "F7k88Dj4uRgChaXjhxyciBaGKNBrsgUJ8h6JhU1HrCSC",
        "block_height": 216684338,
        "block_timestamp": 1790028249450768600,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"NXnLsg3W4Ast2GMPHaDJwQ6LEKbR9Y54ufBf6vFC2uW\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-staging.near\",\"tokens\":{\"nep141:wrap.near\":\"248071769999999997002859\"}}]}"
          ],
          "status": {
            "Failure": {}
          },
          "receipt_ids": [
            "7wKpENuQ7TuKF5H5vFQmLkZYhTsnMKvMmSRQzu27am3x"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "7wKpENuQ7TuKF5H5vFQmLkZYhTsnMKvMmSRQzu27am3x",
        "block_height": 216684339,
        "block_timestamp": 1790028250034192100,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** An EVM account's first allocation into intentfolio-vault.near: a `transfer` to the vault and four vault events. */
export const EVM_ALLOCATE: FastNearTx = {
  "transaction": {
    "hash": "3teaiT8pbWBu3cNmkVaEBWkKdz5SJhYNrJcM2jAbzwnT",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 219946711,
    "block_timestamp": 1791990101779608800,
    "outcome": {
      "receipt_ids": [
        "D9HctTJ292mpZ9dDVfbNLAbNBKnR7wm8gYJBc99ko5am"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "D9HctTJ292mpZ9dDVfbNLAbNBKnR7wm8gYJBc99ko5am",
        "block_height": 219946712,
        "block_timestamp": 1791990102311792600,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"26Kvj97v1Mqxiz3d5SzBwdvdmd9KWB6Wf2ma7ut5qPm3\",\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"receiver_id\":\"intentfolio-vault.near\",\"tokens\":{\"nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near\":\"1000000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"26Kvj97v1Mqxiz3d5SzBwdvdmd9KWB6Wf2ma7ut5qPm3\",\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"nonce\":\"Vij2xgAlKBKzACAvJk1/4RiDynr/WcOnkalZEJKQrzE=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"new_owner_id\":\"intentfolio-vault.near\",\"token_ids\":[\"nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near\"],\"amounts\":[\"1000000\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "3UDVb8Ga4KguHysjLDPsqcTFD1Yi6GukuLQEKdvfNqiZ",
            "AHGqTeGDZcQTuy1cX4EhX44VMNybGmSPBiUi1ibk7Yo"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3UDVb8Ga4KguHysjLDPsqcTFD1Yi6GukuLQEKdvfNqiZ",
        "block_height": 219946713,
        "block_timestamp": 1791990102849764900,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"register_user\",\"data\":[{\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"link_wallet\",\"data\":[{\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"chain\":\"evm\",\"address\":\"0xc8B1e10d011ACeEd84F4CDBa66ca175bD6552A36\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_created\",\"data\":[{\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"portfolio_id\":\"p_000000000006\",\"name\":\"Balanced\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"portfolio_id\":\"p_000000000006\",\"token\":\"nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near\",\"qty\":\"1000000\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "6mz8M9yQjY9mkPaSDfJzocLfkoR8KPke5xA993NA93f4"
          ]
        }
      },
      "receipt": {
        "receipt_id": "3UDVb8Ga4KguHysjLDPsqcTFD1Yi6GukuLQEKdvfNqiZ",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "on_auth",
                  "args": "eyJzaWduZXJfaWQiOiIweGM4YjFlMTBkMDExYWNlZWQ4NGY0Y2RiYTY2Y2ExNzViZDY1NTJhMzYiLCJtc2ciOiJ7XCJkZWFkbGluZVwiOjE3OTIyNDkyOTYsXCJub25jZVwiOlsxODEsMTc0LDIwOCwyMzAsMjA4LDE1MSw1Myw4Myw0MSwxNTcsMjMxLDEwNiwxOTgsMjM5LDIxNiw4MCwxNjQsMjM5LDE2MiwxMDgsMjQyLDkzLDE0MSwxNTAsMTc0LDE2MCwyMDMsMTg3LDQwLDE1MywxNzAsMjJdLFwib3BcIjp7XCJzZXR1cFwiOntcImxvZ2luX3dhbGxldFwiOntcImNoYWluXCI6XCJldm1cIixcImFkZHJlc3NcIjpcIjB4YzhCMWUxMGQwMTFBQ2VFZDg0RjRDREJhNjZjYTE3NWJENjU1MkEzNlwifSxcInBvcnRmb2xpb19uYW1lXCI6XCJCYWxhbmNlZFwiLFwiY29tcG9zaXRpb25cIjpbe1widG9rZW5faWRcIjpcIm5lcDE0MTpuYnRjLmJyaWRnZS5uZWFyXCIsXCJ0YXJnZXRfYnBzXCI6MjQwNCxcInRvbGVyYW5jZV9icHNcIjo4MDB9LHtcInRva2VuX2lkXCI6XCJuZXAxNDE6ZXRoLmJyaWRnZS5uZWFyXCIsXCJ0YXJnZXRfYnBzXCI6NDkwMCxcInRvbGVyYW5jZV9icHNcIjoxMDAwfSx7XCJ0b2tlbl9pZFwiOlwibmVwMTQxOjE3MjA4NjI4Zjg0ZjVkNmFkMzNmMGRhM2JiYmViMjdmZmNiMzk4ZWFjNTAxYTMxYmQ2YWQyMDExZTM2MTMzYTFcIixcInRhcmdldF9icHNcIjozMDAsXCJ0b2xlcmFuY2VfYnBzXCI6ODAwfSx7XCJ0b2tlbl9pZFwiOlwibmVwMTQxOndyYXAubmVhclwiLFwidGFyZ2V0X2Jwc1wiOjExOTgsXCJ0b2xlcmFuY2VfYnBzXCI6ODAwfSx7XCJ0b2tlbl9pZFwiOlwibmVwMTQxOnNvbC5vbWZ0Lm5lYXJcIixcInRhcmdldF9icHNcIjoxMTk4LFwidG9sZXJhbmNlX2Jwc1wiOjgwMH1dLFwiYWxsb2NhdGlvbnNcIjpbW1wibmVwMTQxOmFyYi0weGZkMDg2YmM3Y2Q1YzQ4MWRjYzljODVlYmU0NzhhMWMwYjY5ZmNiYjkub21mdC5uZWFyXCIsXCIxMDAwMDAwXCJdXX19fSJ9",
                  "gas": 294219316408314,
                  "deposit": "0"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "AHGqTeGDZcQTuy1cX4EhX44VMNybGmSPBiUi1ibk7Yo",
        "block_height": 219946713,
        "block_timestamp": 1791990102849764900,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "6mz8M9yQjY9mkPaSDfJzocLfkoR8KPke5xA993NA93f4",
        "block_height": 219946714,
        "block_timestamp": 1791990103492351500,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** An EVM account's HOT withdrawal that buys gas: a solver's `token_diff`, then ONE `mt_burn` entry with two tokens. */
export const EVM_HOT_WITHDRAWAL: FastNearTx = {
  "transaction": {
    "hash": "Cs4K8v5gs2XDWRzKdyzRV3LVsSo6CRup9F7pdG43sZR4",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 210178906,
    "block_timestamp": 1786024735751769600,
    "outcome": {
      "receipt_ids": [
        "3g2rBUbsmfXDHWMiKWnRZ8qumm7tVhjhNYjMNgFzCNHA"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "3g2rBUbsmfXDHWMiKWnRZ8qumm7tVhjhNYjMNgFzCNHA",
        "block_height": 210178906,
        "block_timestamp": 1786024735751769600,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"5J8xS9XKRwGKitn7aWhrrsoXcUTRDZdENQ9b2ZBixK8L\",\"account_id\":\"blockzen-near-intent.near\",\"diff\":{\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\":\"-72238557238357239\",\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\":\"5568\"},\"fees_collected\":{\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\":\"72238557239\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"CDKeCi1ZqmfM3f3oR4PqLqmhTadzAMfiWoXr6h9nkBW\",\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"diff\":{\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\":\"72238484999800000\",\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\":\"-5569\"},\"fees_collected\":{\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\":\"1\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"mt_withdraw\",\"data\":[{\"intent_hash\":\"CDKeCi1ZqmfM3f3oR4PqLqmhTadzAMfiWoXr6h9nkBW\",\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"token\":\"v2_1.omni.hot.tg\",\"receiver_id\":\"bridge-refuel.hot.tg\",\"token_ids\":[\"137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\",\"137_11111111111111111111\"],\"amounts\":[\"494431\",\"72238484999800000\"],\"msg\":\"{\\\"receiver_id\\\":\\\"MVi7oGwG6nmofKXD3AGLSuD6FnF\\\",\\\"amount_native\\\":\\\"72238484999800000\\\",\\\"block_number\\\":91546467}\",\"min_gas\":\"91300000000000\"}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"5J8xS9XKRwGKitn7aWhrrsoXcUTRDZdENQ9b2ZBixK8L\",\"account_id\":\"blockzen-near-intent.near\",\"nonce\":\"f4VoU45ONrgEvPqeElus4mguwu65nmxUzsvFk5J4Oj0=\"},{\"intent_hash\":\"CDKeCi1ZqmfM3f3oR4PqLqmhTadzAMfiWoXr6h9nkBW\",\"account_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"nonce\":\"fX27wBiDbr5Owd57Rx/0R1/tRr68Yfl1xBff2dkYQUQ=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"blockzen-near-intent.near\",\"new_owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\"],\"amounts\":[\"72238484999800000\"]},{\"old_owner_id\":\"blockzen-near-intent.near\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\"],\"amounts\":[\"72238557239\"]},{\"old_owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"new_owner_id\":\"blockzen-near-intent.near\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"5568\"]},{\"old_owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"1\"]}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\",\"nep245:v2_1.omni.hot.tg:137_11111111111111111111\"],\"amounts\":[\"494431\",\"72238484999800000\"],\"memo\":\"withdraw\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "8UgDpdMUY7MUarQjmkDhUqnfAspYqnVwMGMUCJdjt1fn",
            "JDyPfHUALYXuzNZ1i4vd5YncHSZjM2JjfLnYXVuT1hBo",
            "3vjBrKXCX9KWgcRujCTDh2fLqXxKLAh6M6bPyLJXEhQF"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3vjBrKXCX9KWgcRujCTDh2fLqXxKLAh6M6bPyLJXEhQF",
        "block_height": 210178907,
        "block_timestamp": 1786024736569098800,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "8UgDpdMUY7MUarQjmkDhUqnfAspYqnVwMGMUCJdjt1fn",
        "block_height": 210178907,
        "block_timestamp": 1786024736569098800,
        "outcome": {
          "executor_id": "v2_1.omni.hot.tg",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"intents.near\",\"new_owner_id\":\"bridge-refuel.hot.tg\",\"token_ids\":[\"137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\",\"137_11111111111111111111\"],\"amounts\":[\"494431\",\"72238484999800000\"]}]}"
          ],
          "status": {
            "SuccessReceiptId": "9qoJJN44Hidf8QzhaqWWFnP5CbNn7r37aJwkv6o8Jcs4"
          },
          "receipt_ids": [
            "6rVmccKcoiZ5cKDhNjm5iHsLAoUjpxG9TuVa44EB3ZAM",
            "9qoJJN44Hidf8QzhaqWWFnP5CbNn7r37aJwkv6o8Jcs4",
            "7MrCQqGzVHmzoqDF4nWd9h1yovtEaJBzPmv7BqY8QZ8"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "6rVmccKcoiZ5cKDhNjm5iHsLAoUjpxG9TuVa44EB3ZAM",
        "block_height": 210178908,
        "block_timestamp": 1786024736966269700,
        "outcome": {
          "executor_id": "bridge-refuel.hot.tg",
          "logs": [
            "prepaid_gas: NearGas { inner: 131830744266322 }"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "Bz7DwsGXyyMPBz2sdqWxtccxBMuQVDjxkML9g3qCAcKo",
            "85AtcW6r2MbnmGTtCRXMWDiqzVkK8oiViGWWbR8a2wUH",
            "HvDHmwmc4Q65ABe98YNciMnCvHxQYz2HYiWHq16xgZcC"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "7MrCQqGzVHmzoqDF4nWd9h1yovtEaJBzPmv7BqY8QZ8",
        "block_height": 210178908,
        "block_timestamp": 1786024736966269700,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "HvDHmwmc4Q65ABe98YNciMnCvHxQYz2HYiWHq16xgZcC",
        "block_height": 210178909,
        "block_timestamp": 1786024737757738200,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "Bz7DwsGXyyMPBz2sdqWxtccxBMuQVDjxkML9g3qCAcKo",
        "block_height": 210178909,
        "block_timestamp": 1786024737757738200,
        "outcome": {
          "executor_id": "v2_1.omni.hot.tg",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"bridge-refuel.hot.tg\",\"token_ids\":[\"137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"494431\"],\"memo\":\"1786024737000001568924\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "CPH9TAqk7Jcaj7BNKn5hkya4HEGhizEwghLei1yGu8rq"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "9qoJJN44Hidf8QzhaqWWFnP5CbNn7r37aJwkv6o8Jcs4",
        "block_height": 210178909,
        "block_timestamp": 1786024737757738200,
        "outcome": {
          "executor_id": "v2_1.omni.hot.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "9xbQCkzXnSpdGw5QdUYxaq6zoxAKC4YkxHk7QWkrNVXN"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "85AtcW6r2MbnmGTtCRXMWDiqzVkK8oiViGWWbR8a2wUH",
        "block_height": 210178910,
        "block_timestamp": 1786024738036952800,
        "outcome": {
          "executor_id": "bridge-refuel.hot.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "HwWd7naunE1WhDDPkJwZoiS28A7qnJXbnT6GDPw7M5T7"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "CPH9TAqk7Jcaj7BNKn5hkya4HEGhizEwghLei1yGu8rq",
        "block_height": 210178910,
        "block_timestamp": 1786024738036952800,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "9xbQCkzXnSpdGw5QdUYxaq6zoxAKC4YkxHk7QWkrNVXN",
        "block_height": 210178910,
        "block_timestamp": 1786024738036952800,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "JDyPfHUALYXuzNZ1i4vd5YncHSZjM2JjfLnYXVuT1hBo",
        "block_height": 210178910,
        "block_timestamp": 1786024738036952800,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "GFmUYHcYr1bNdchNXY8CSdL7JbeQ3qvaCoeVNqbSzVcu"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "GFmUYHcYr1bNdchNXY8CSdL7JbeQ3qvaCoeVNqbSzVcu",
        "block_height": 210178911,
        "block_timestamp": 1786024738572858000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "HwWd7naunE1WhDDPkJwZoiS28A7qnJXbnT6GDPw7M5T7",
        "block_height": 210178911,
        "block_timestamp": 1786024738572858000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** An EVM account's HOT deposit: a foreign `mt_mint` (HOT's contract) and `intents.near`'s own. */
export const EVM_HOT_DEPOSIT: FastNearTx = {
  "transaction": {
    "hash": "kaXJVqJ5ZWZiXTUKVe2xdgdwZLf78dvQiomVd7gTrDJ",
    "signer_id": "0here.tg",
    "receiver_id": "v2_1.omni.hot.tg"
  },
  "execution_outcome": {
    "block_height": 210170145,
    "block_timestamp": 1786019238927201300,
    "outcome": {
      "receipt_ids": [
        "9G4xV6VSUx3yYhUegHUFxDn5d76gFoVwLbxZgTeMHfBN"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "9G4xV6VSUx3yYhUegHUFxDn5d76gFoVwLbxZgTeMHfBN",
        "block_height": 210170146,
        "block_timestamp": 1786019239310197500,
        "outcome": {
          "executor_id": "v2_1.omni.hot.tg",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\",\"data\":[{\"owner_id\":\"hot-dao.sputnik-dao.near\",\"token_ids\":[\"137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"1350000\"]}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"hot-dao.sputnik-dao.near\",\"new_owner_id\":\"intents.near\",\"token_ids\":[\"137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"1350000\"]}]}"
          ],
          "status": {
            "SuccessReceiptId": "Gw6FMDtxzJVTLjvfx7wTg9MtxAnHj98ZFen2EVqz7XLU"
          },
          "receipt_ids": [
            "BZrjhfbvjKGsrXVRfma5ERDJMEmjtX9Vu94ZFZkCJN6v",
            "Gw6FMDtxzJVTLjvfx7wTg9MtxAnHj98ZFen2EVqz7XLU",
            "4UHFzWBrLoNqWzbNDaKbx728oJQHrVmFjqGNidKbswRu"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "4UHFzWBrLoNqWzbNDaKbx728oJQHrVmFjqGNidKbswRu",
        "block_height": 210170147,
        "block_timestamp": 1786019239908701000,
        "outcome": {
          "executor_id": "0here.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "BZrjhfbvjKGsrXVRfma5ERDJMEmjtX9Vu94ZFZkCJN6v",
        "block_height": 210170147,
        "block_timestamp": 1786019239908701000,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\",\"data\":[{\"owner_id\":\"0xc8b1e10d011aceed84f4cdba66ca175bd6552a36\",\"token_ids\":[\"nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr\"],\"amounts\":[\"1350000\"],\"memo\":\"deposit\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "HV9Z9SQNGG4zjR6pXYqg12NG1VMNTP3V6H5Hm6oJ2drW"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "HV9Z9SQNGG4zjR6pXYqg12NG1VMNTP3V6H5Hm6oJ2drW",
        "block_height": 210170148,
        "block_timestamp": 1786019240364431400,
        "outcome": {
          "executor_id": "0here.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "Gw6FMDtxzJVTLjvfx7wTg9MtxAnHj98ZFen2EVqz7XLU",
        "block_height": 210170148,
        "block_timestamp": 1786019240364431400,
        "outcome": {
          "executor_id": "v2_1.omni.hot.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "2Kv34CDYbrpVFKJxdf2c7xT5MWaKzFzqi4MscC2ph82C"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "2Kv34CDYbrpVFKJxdf2c7xT5MWaKzFzqi4MscC2ph82C",
        "block_height": 210170149,
        "block_timestamp": 1786019241047236900,
        "outcome": {
          "executor_id": "0here.tg",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** pablofork.near edits p_000000000001: two new targets and wNEAR added, by `commit_portfolio_changes`. */
export const EDIT: FastNearTx = {
  "transaction": {
    "hash": "CBRAS2PxYNK5enokgBc8RMc7F7tCD8tkvi4eckd2xyc6",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 218838238,
    "block_timestamp": 1791317526209363829,
    "outcome": {
      "receipt_ids": [
        "8HfJtGnLCyDRM898WRp4xTW5mTDDQ8avRBoe9gvH44b4"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "8HfJtGnLCyDRM898WRp4xTW5mTDDQ8avRBoe9gvH44b4",
        "block_height": 218838239,
        "block_timestamp": 1791317526743139293,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_composition_changed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000001\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "CfATXVV2ar1RsR4ZDwibNBw8Bd1To9ZCaCnccR4mqUK3"
          ]
        }
      },
      "receipt": {
        "receipt_id": "8HfJtGnLCyDRM898WRp4xTW5mTDDQ8avRBoe9gvH44b4",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "commit_portfolio_changes",
                  "args": "eyJwYXlsb2FkIjp7InN0YW5kYXJkIjoibmVwNDEzIiwicGF5bG9hZCI6eyJtZXNzYWdlIjoie1wic2lnbmVyX2lkXCI6XCJwYWJsb2ZvcmsubmVhclwiLFwiZGVhZGxpbmVcIjpcIjIwMjYtMTAtMDZUMjA6MjE6NTUuMDAwWlwiLFwicG9ydGZvbGlvX2lkXCI6XCJwXzAwMDAwMDAwMDAwMVwiLFwidGFyZ2V0X2NoYW5nZXNcIjpbW1wibmVwMTQxOm1ldGEtcG9vbC5uZWFyXCIsMzk1MCwyMDAwXSxbXCJuZXAxNDE6dXNkdC50ZXRoZXItdG9rZW4ubmVhclwiLDIzNTAsMjAwMF1dLFwidG9rZW5fYWRkaXRpb25zXCI6W1tcIm5lcDE0MTp3cmFwLm5lYXJcIiwzNzAwLDEwMDBdXSxcInRva2VuX3JlbW92YWxzXCI6W10sXCJ1bmFsbG9jYXRpb25zXCI6W119Iiwibm9uY2UiOiJWaWoyeGdBQUFBQUFBQjVNdEZVSzNCamJvT29VUHRKRC9UcFZwTWIvM28wPSIsInJlY2lwaWVudCI6ImludGVudGZvbGlvLXZhdWx0Lm5lYXIifSwicHVibGljX2tleSI6ImVkMjU1MTk6MkVWZ3lIeVJaWlVXcmZmZUxyaWhZQjh2RkxXZndRdmU2TUE1ZWlXYVVmeFYiLCJzaWduYXR1cmUiOiJlZDI1NTE5OjI5cDZaMlZiSmtueDFqUUx6VFhqcldubkgyN1ZNaVF6TXBYcFRjQThzRXlnNlcxNWI0UDlBU1J6S2V0czJzcnRCOHF3UWdnem40S3NmMWRpeUVxeEgxTk0ifX0=",
                  "gas": 300000000000000,
                  "deposit": "0"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "CfATXVV2ar1RsR4ZDwibNBw8Bd1To9ZCaCnccR4mqUK3",
        "block_height": 218838240,
        "block_timestamp": 1791317527343735900,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};

/** pablofork.near allocates into p_000000000001 with a token added in the same signature (`on_auth`, `allocate_into`). */
export const EDIT_ALLOCATE_INTO: FastNearTx = {
  "transaction": {
    "hash": "3FutWWQAeMDaAScqqC8PbnQdF7Cj5qqCfSvAEY9v3dn5",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 219958825,
    "block_timestamp": 1791997287079118285,
    "outcome": {
      "receipt_ids": [
        "3BBM83Jw69XXMtTg9vHR9M9DZsMVgGoghwVRJwdxCj4X"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "3BBM83Jw69XXMtTg9vHR9M9DZsMVgGoghwVRJwdxCj4X",
        "block_height": 219958826,
        "block_timestamp": 1791997287489928008,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"DVfC71XpjRseX91uWWJXJ7aotVhpuM88xvAvBDFmfiXz\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-vault.near\",\"tokens\":{\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\":\"43956\",\"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near\":\"750000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.4.3\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"DVfC71XpjRseX91uWWJXJ7aotVhpuM88xvAvBDFmfiXz\",\"account_id\":\"pablofork.near\",\"nonce\":\"Vij2xgAlKBKzAGIjG9WF4RiAqwpc4KVUWBCBjUqhqPM=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intentfolio-vault.near\",\"token_ids\":[\"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near\",\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\"],\"amounts\":[\"750000\",\"43956\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "9XvvCDmfBUdLUwG6k4X6nbvRAZGTXg6eyK5f9p9mDRY5",
            "521jmaTChFk7tYT2rkjkJDBSGG1F1jx4AGw9A131bXjE"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "9XvvCDmfBUdLUwG6k4X6nbvRAZGTXg6eyK5f9p9mDRY5",
        "block_height": 219958827,
        "block_timestamp": 1791997288133176692,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_composition_changed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000001\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000001\",\"token\":\"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near\",\"qty\":\"750000\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000001\",\"token\":\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\",\"qty\":\"43956\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "6wiJq9Wu4757kj4yLrJicvLdpnQfFYeNA3Kq3JzMYTQ9"
          ]
        }
      },
      "receipt": {
        "receipt_id": "9XvvCDmfBUdLUwG6k4X6nbvRAZGTXg6eyK5f9p9mDRY5",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "on_auth",
                  "args": "eyJzaWduZXJfaWQiOiJwYWJsb2ZvcmsubmVhciIsIm1zZyI6IntcImRlYWRsaW5lXCI6MTc5MjI1NjQ3NyxcIm5vbmNlXCI6WzEwOSwyMjgsMTYwLDIxMCw2NiwxMTgsOTEsNzIsMTM3LDg4LDMwLDMwLDIxMywyMTIsMTg1LDYwLDMxLDEzNyw1MSwyMTUsNjUsMzUsNzEsMTU0LDEyMywxODYsMjAwLDkwLDE1NywxODQsMTk1LDE5Ml0sXCJvcFwiOntcImFsbG9jYXRlX2ludG9cIjp7XCJwb3J0Zm9saW9faWRcIjpcInBfMDAwMDAwMDAwMDAxXCIsXCJ0YXJnZXRfY2hhbmdlc1wiOltdLFwidG9rZW5fYWRkaXRpb25zXCI6W1tcIm5lcDE0MTphcmItMHhhZjg4ZDA2NWU3N2M4Y2MyMjM5MzI3YzVlZGIzYTQzMjI2OGU1ODMxLm9tZnQubmVhclwiLDAsMTAwMF0sW1wibmVwMTQxOjE3MjA4NjI4Zjg0ZjVkNmFkMzNmMGRhM2JiYmViMjdmZmNiMzk4ZWFjNTAxYTMxYmQ2YWQyMDExZTM2MTMzYTFcIiwwLDEwMDBdLFtcIm5lcDE0MTp0b2tlbi5yaGVhbGFiLm5lYXJcIiwwLDEwMDBdLFtcIm5lcDE0MTphYWFhYWEyMGQ5ZTBlMjQ2MTY5Nzc4MmVmMTE2NzVmNjY4MjA3OTYxLmZhY3RvcnkuYnJpZGdlLm5lYXJcIiwwLDEwMDBdXSxcInRva2VuX3JlbW92YWxzXCI6W10sXCJhbGxvY2F0aW9uc1wiOltbXCJuZXAxNDE6YXJiLTB4YWY4OGQwNjVlNzdjOGNjMjIzOTMyN2M1ZWRiM2E0MzIyNjhlNTgzMS5vbWZ0Lm5lYXJcIixcIjc1MDAwMFwiXSxbXCJuZXAxNDE6MTcyMDg2MjhmODRmNWQ2YWQzM2YwZGEzYmJiZWIyN2ZmY2IzOThlYWM1MDFhMzFiZDZhZDIwMTFlMzYxMzNhMVwiLFwiNDM5NTZcIl1dfX19In0=",
                  "gas": 293530733460746,
                  "deposit": "0"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "521jmaTChFk7tYT2rkjkJDBSGG1F1jx4AGw9A131bXjE",
        "block_height": 219958827,
        "block_timestamp": 1791997288133176692,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "6wiJq9Wu4757kj4yLrJicvLdpnQfFYeNA3Kq3JzMYTQ9",
        "block_height": 219958828,
        "block_timestamp": 1791997288651717021,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
