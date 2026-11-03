// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice The subset of Swarm's PostageStamp the registry uses
///         (ethersphere/storage-incentives; DESIGN §14).
interface IPostageStampLike {
    struct Batch {
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        bool immutableFlag;
        uint256 normalisedBalance;
        uint256 lastUpdatedBlockNumber;
    }

    function batches(bytes32 id)
        external
        view
        returns (
            address owner,
            uint8 depth,
            uint8 bucketDepth,
            bool immutableFlag,
            uint256 normalisedBalance,
            uint256 lastUpdatedBlockNumber
        );

    function currentTotalOutPayment() external view returns (uint256);

    function lastPrice() external view returns (uint64);

    function minimumValidityBlocks() external view returns (uint64);

    function minimumBucketDepth() external view returns (uint8);

    function minimumInitialBalancePerChunk() external view returns (uint256);

    function createBatch(
        address owner,
        uint256 initialBalancePerChunk,
        uint8 depth,
        uint8 bucketDepth,
        bytes32 nonce,
        bool immutableFlag
    ) external returns (bytes32);

    function topUp(bytes32 batchId, uint256 topupAmountPerChunk) external;
}
