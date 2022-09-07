import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { deployContract, solidity } from "ethereum-waffle";
import { formatUnits, parseEther, parseUnits } from "ethers/lib/utils";
import hre, { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { TestToken, LockerFactory, Locker } from "../typechain";

import {
  advanceBlock,
  advanceTimeAndBlock,
  ether,
  wei,
  ZERO,
  getLatestBlockTimestamp,
  getLatestBlockNumber,
  revertEvm,
  getSnapShot,
  ZERO_ADDRESS,
  ONE_WEEK_IN_SECONDS,
  ONE_DAY_IN_SECONDS,
} from "./utils";

const { expect } = chai;

chai.use(solidity);

describe("LockerFactory and Locker", function () {
  let owner: SignerWithAddress;
  let token: TestToken;

  let tester1: SignerWithAddress;
  let tester2: SignerWithAddress;
  let tester3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const createFee = parseEther("1");
  const emergencyUnlockFee = parseEther("2");

  let factory: LockerFactory;
  let locker: Locker;
  let timestamp: number;

  let startTime: number;
  let endTime: number;

  let cliffTime: number;
  let duration: number;
  let periodicity: number;

  let meta = "https://meta.com";
  let meta1 = "https://meta1.com";

  let proposalEndTime: number;

  before(async function () {
    const signers: SignerWithAddress[] = await hre.ethers.getSigners();

    owner = signers[0];
    tester1 = signers[1];
    tester2 = signers[2];
    tester3 = signers[3];
    feeRecipient = signers[4];

    const TestTokenArtifact: Artifact = await hre.artifacts.readArtifact("TestToken");
    token = <TestToken>await deployContract(owner, TestTokenArtifact);

    const LockerFactoryArtifact: Artifact = await hre.artifacts.readArtifact("LockerFactory");
    factory = <LockerFactory>(
      await deployContract(owner, LockerFactoryArtifact, [feeRecipient.address, createFee, emergencyUnlockFee])
    );

    timestamp = await getLatestBlockTimestamp();

    startTime = timestamp + 1000;
    endTime = timestamp + 1000 + ONE_WEEK_IN_SECONDS.toNumber();

    cliffTime = timestamp + 1000;
    duration = ONE_WEEK_IN_SECONDS.toNumber();
    periodicity = duration / 4;

    await token.connect(tester1).mint();
    await token.connect(tester2).mint();
    await token.connect(tester3).mint();
  });

  describe("lockerFactory", function () {
    it("check feeInfo", async () => {
      expect(await factory.feeRecipient()).to.equal(feeRecipient.address);
      expect(await factory.createFee()).to.equal(createFee);
      expect(await factory.emergencyUnlockFee()).to.equal(emergencyUnlockFee);

      const feeInfo = await factory.getFeeInfo();
      expect(feeInfo[0]).to.equal(feeRecipient.address);
      expect(feeInfo[1]).to.equal(createFee);
      expect(feeInfo[2]).to.equal(emergencyUnlockFee);
    });

    it("check setFeeInfo", async () => {
      await expect(
        factory.connect(tester1).setFeeInfo(feeRecipient.address, createFee, emergencyUnlockFee),
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(factory.setFeeInfo(ZERO_ADDRESS, createFee, emergencyUnlockFee)).to.be.revertedWith(
        "Invalid feeRecipient",
      );

      await factory.setFeeInfo(tester1.address, emergencyUnlockFee, createFee);
      expect(await factory.feeRecipient()).to.equal(tester1.address);
      expect(await factory.createFee()).to.equal(emergencyUnlockFee);
      expect(await factory.emergencyUnlockFee()).to.equal(createFee);

      await factory.setFeeInfo(feeRecipient.address, createFee, emergencyUnlockFee);
    });

    it("create linear lock", async () => {
      const prevFeeRecipientBal = await ethers.provider.getBalance(feeRecipient.address);

      await expect(factory.createLocker(0, 0, 0, 0, ZERO_ADDRESS, false, meta)).to.be.revertedWith("Insufficient fee");
      await expect(
        factory.createLocker(0, 0, 0, 0, ZERO_ADDRESS, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid token");
      await expect(
        factory.createLocker(2, 0, 0, 0, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid lockType");

      await expect(
        factory.createLocker(2, 0, 0, 0, token.address, true, meta, { value: createFee }),
      ).to.be.revertedWith("");

      await expect(
        factory.createLocker(0, startTime, 0, 0, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid endTime");

      await factory.createLocker(0, startTime, endTime, 0, token.address, false, meta, { value: createFee });

      const afterFeeRecipientBal = await ethers.provider.getBalance(feeRecipient.address);
      expect(afterFeeRecipientBal.sub(prevFeeRecipientBal)).to.equal(createFee);
    });

    it("create vesting lock", async () => {
      await expect(
        factory.createLocker(1, 0, 0, 0, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid cliffTime");
      await expect(
        factory.createLocker(1, cliffTime, 0, 0, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid duration");
      await expect(
        factory.createLocker(1, cliffTime, duration, 0, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid periodicity");
      await expect(
        factory.createLocker(1, cliffTime, duration, periodicity + 1, token.address, false, meta, { value: createFee }),
      ).to.be.revertedWith("Invalid periodicity");

      await factory.createLocker(1, cliffTime, duration, periodicity, token.address, false, meta, { value: createFee });
    });

    it("check get functions", async () => {
      expect(await factory.getTotalLockCount()).to.equal(wei(2));

      const addrs = await factory.getLockAddresses(0, 3);
      expect(addrs.length).to.equal(2);
      expect(await factory.lockers(0)).to.equal(addrs[0]);
      expect(await factory.lockers(1)).to.equal(addrs[1]);
    });
  });

  describe("simple locker", function () {
    let snapshotID: any;
    before(async () => {
      snapshotID = await getSnapShot();
    });
    after(async () => {
      await revertEvm(snapshotID);
    });

    describe("init and do basic actions", () => {
      it("get Locker", async () => {
        const addr = await factory.lockers(0);
        const LockerArtifact: Artifact = await hre.artifacts.readArtifact("Locker");
        locker = <Locker>await ethers.getContractAt(LockerArtifact.abi, addr);
      });

      it("check initial values", async () => {
        expect(await locker.token()).to.equal(token.address);
        expect(await locker.startTime()).to.equal(wei(startTime));
        expect(await locker.endTime()).to.equal(wei(endTime));
        expect(await locker.lockType()).to.equal(wei(0));
        expect(await locker.uri()).to.equal(meta);
      });

      it("deposit", async () => {
        await token.connect(tester1).approve(locker.address, ether(100000));
        await token.connect(tester2).approve(locker.address, ether(100000));
        await token.connect(tester3).approve(locker.address, ether(100000));

        await locker.connect(tester1).deposit(ether(100));
        await locker.connect(tester2).deposit(ether(100));
        await locker.connect(tester3).deposit(ether(100));

        await locker.connect(tester3).depositFor(ether(100), tester2.address);
        await locker.connect(tester3).depositFor(ether(200), tester1.address);

        // 300, 200, 100
      });

      it("check current info", async () => {
        expect(await locker.totalDeposited()).to.equal(ether(600));

        let info;
        info = await locker.userInfo(tester1.address);
        expect(info.amount).to.equal(ether(300));

        info = await locker.userInfo(tester2.address);
        expect(info.amount).to.equal(ether(200));

        info = await locker.userInfo(tester3.address);
        expect(info.amount).to.equal(ether(100));

        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ZERO);
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ZERO);
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ZERO);

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(300));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(200));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(100));
      });

      it("check setUri", async () => {
        await expect(locker.connect(tester1).setUri(meta1)).to.be.revertedWith("Ownable: caller is not the owner");
        await locker.setUri(meta1);
        expect(await locker.uri()).to.equal(meta1);
      });
    });

    describe("check claim", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });
      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(startTime - timestamp + periodicity); // 1/4 passed
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(25));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(225));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(75));
      });

      it("claim from tester1", async () => {
        const prev = await token.balanceOf(tester1.address);
        await locker.connect(tester1).claim();
        const after = await token.balanceOf(tester1.address);
        expect(after.sub(prev)).gt(ether(75));

        expect((await locker.userInfo(tester1.address)).claimedAmount).to.gt(ether(75));
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(startTime - timestamp + periodicity * 2); // 1/2 passed
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.lt(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("claim from tester1 and 2", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(endTime - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.lt(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.lt(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(100));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(0));
      });

      it("claim all", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
        await locker.connect(tester3).claim();
      });

      it("check", async () => {
        expect(await locker.totalClaimed()).to.equal(ether(600));
        expect(await token.balanceOf(locker.address)).to.equal(ether(0));
      });
    });

    describe("unlock by admin function", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });

      it("suggestUnlock", async () => {
        await expect(locker.connect(tester1).suggestUnlock(wei(5000))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );

        await expect(locker.suggestUnlock(wei(0))).to.be.revertedWith("Invalid _suggestedUnlockPercent");

        await expect(locker.suggestUnlock(wei(5000))).to.be.revertedWith("Insufficient fee");

        const prevBal = await ethers.provider.getBalance(feeRecipient.address);
        await locker.suggestUnlock(wei(5000), { value: emergencyUnlockFee });
        const afterBal = await ethers.provider.getBalance(feeRecipient.address);
        expect(afterBal.sub(prevBal)).to.equal(emergencyUnlockFee);
      });

      it("approveSuggestedUnlock", async () => {
        await expect(factory.connect(tester1).approveUnlock(locker.address)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );

        await factory.approveUnlock(locker.address);

        expect(await locker.suggestedUnlockPercent()).to.equal(ZERO);
        expect(await locker.unlockedPercent()).to.equal(wei(5000));
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("claim from tester1", async () => {
        await locker.connect(tester1).claim();
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(startTime - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("claim from tester2", async () => {
        await locker.connect(tester2).claim();
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(startTime - timestamp + periodicity * 2);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("suggest again", async () => {
        await expect(locker.suggestUnlock(5000)).to.be.revertedWith("Invalid _suggestedUnlockPercent");

        await locker.suggestUnlock(7500, { value: emergencyUnlockFee });
      });

      it("approve again", async () => {
        await factory.approveUnlock(locker.address);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(75));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(75));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(50));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(25));
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(endTime - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(100));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(0));
      });

      it("claim all", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
        await locker.connect(tester3).claim();
      });

      it("check", async () => {
        expect(await locker.totalClaimed()).to.equal(ether(600));
        expect(await token.balanceOf(locker.address)).to.equal(ether(0));
      });
    });

    describe("unlock by proposal", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });

      describe("do initial action", function () {
        it("try vote", async () => {
          await expect(locker.connect(tester1).vote(ether(100), true)).to.be.revertedWith("Not active");
        });

        it("try to end", async () => {
          await expect(locker.connect(tester1).endProposal()).to.be.revertedWith("Ownable: caller is not the owner");
          await expect(locker.endProposal()).to.be.revertedWith("No active proposal");
        });

        it("startProposal", async () => {
          await expect(locker.connect(tester1).startProposal(0, 0)).to.be.revertedWith(
            "Ownable: caller is not the owner",
          );
          await expect(locker.startProposal(0, 0)).to.be.revertedWith("Invalid _unlockPercent");
          await expect(locker.startProposal(5000, 0)).to.be.revertedWith("Invalid _endTime");

          timestamp = await getLatestBlockTimestamp();
          proposalEndTime = timestamp + ONE_DAY_IN_SECONDS.toNumber() + 100;

          await locker.startProposal(5000, proposalEndTime);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          expect(proposal.endTime).to.equal(wei(proposalEndTime));
          expect(proposal.totalPower).to.equal(ether(600));
        });
      });

      describe("Agree vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await expect(locker.connect(tester1).vote(ether(400), true)).to.be.revertedWith("Invalid power");

          await locker.connect(tester1).vote(ether(100), true);

          expect(await locker.userVote(1, tester1.address)).to.equal(ether(100));
        });

        it("try to end", async () => {
          await expect(locker.endProposal()).to.be.revertedWith("Can't end yet");
        });

        it("vote more for success", async () => {
          await locker.connect(tester2).vote(ether(200), true);
          await locker.connect(tester3).vote(ether(50), true);
          await expect(locker.connect(tester3).vote(ether(60), true)).to.be.revertedWith("Invalid power");
          await locker.connect(tester3).vote(ether(50), false);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();

          expect(proposal.agree).to.equal(ether(350));
          expect(proposal.disagree).to.equal(ether(50));
        });

        it("endProposal", async () => {
          await expect(locker.startProposal(6000, proposalEndTime)).to.be.revertedWith("Can't init a proposal");

          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(350));
          expect(proposal.disagree).to.equal(ether(50));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(5000));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(startTime - timestamp);
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("claim some", async () => {
          await locker.connect(tester1).claim();
          await locker.connect(tester2).claim();
          await locker.connect(tester3).claim();
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(startTime - timestamp + periodicity);
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(0));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("start a new proposal", async () => {
          timestamp = await getLatestBlockTimestamp();
          proposalEndTime = timestamp + ONE_DAY_IN_SECONDS.toNumber() + 100;
          await locker.startProposal(7500, proposalEndTime);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(2));
          expect(proposal.unlockPercent).to.equal(wei(7500));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          expect(proposal.endTime).to.equal(wei(proposalEndTime));
          expect(proposal.totalPower).to.equal(ether(300));
        });

        it("vote for success and end", async () => {
          await locker.connect(tester1).vote(ether(100), true);
          await locker.connect(tester2).vote(ether(80), true);
          await locker.connect(tester3).vote(ether(40), true);

          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(1);
          expect(proposal.id).to.equal(wei(2));
          expect(proposal.unlockPercent).to.equal(wei(7500));
          expect(proposal.totalPower).to.equal(ether(300));
          expect(proposal.agree).to.equal(ether(220));
          expect(proposal.disagree).to.equal(ether(0));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(7500));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(25));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(75));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(50));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(25));
        });
      });

      describe("Disagree vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await locker.connect(tester1).vote(ether(100), false);
        });

        it("vote more for success", async () => {
          await locker.connect(tester2).vote(ether(200), false);
          await locker.connect(tester3).vote(ether(50), false);
          await locker.connect(tester3).vote(ether(50), true);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();

          expect(proposal.agree).to.equal(ether(50));
          expect(proposal.disagree).to.equal(ether(350));
        });

        it("endProposal", async () => {
          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(50));
          expect(proposal.disagree).to.equal(ether(350));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(0));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(0));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(300));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(200));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(100));
        });
      });

      describe("expire vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await locker.connect(tester1).vote(ether(100), false);
        });

        it("advance time", async () => {
          await advanceTimeAndBlock(ONE_DAY_IN_SECONDS.toNumber() + 1000);
        });

        it("endProposal", async () => {
          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(0));
          expect(proposal.disagree).to.equal(ether(100));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(0));
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(startTime - timestamp + periodicity * 2); // 1/2 passed
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });
      });
    });
  });

  describe("vesting locker", function () {
    let snapshotID: any;
    before(async () => {
      snapshotID = await getSnapShot();
    });
    after(async () => {
      await revertEvm(snapshotID);
    });

    describe("init and do basic actions", () => {
      it("get Locker", async () => {
        const addr = await factory.lockers(1);
        const LockerArtifact: Artifact = await hre.artifacts.readArtifact("Locker");
        locker = <Locker>await ethers.getContractAt(LockerArtifact.abi, addr);
      });

      it("check initial values", async () => {
        expect(await locker.token()).to.equal(token.address);
        expect(await locker.cliffTime()).to.equal(wei(cliffTime));
        expect(await locker.duration()).to.equal(wei(duration));
        expect(await locker.periodicity()).to.equal(wei(periodicity));
        expect(await locker.lockType()).to.equal(wei(1));
        expect(await locker.uri()).to.equal(meta);
      });

      it("deposit", async () => {
        await token.connect(tester1).approve(locker.address, ether(100000));
        await token.connect(tester2).approve(locker.address, ether(100000));
        await token.connect(tester3).approve(locker.address, ether(100000));

        await locker.connect(tester1).deposit(ether(100));
        await locker.connect(tester2).deposit(ether(100));
        await locker.connect(tester3).deposit(ether(100));

        await locker.connect(tester3).depositFor(ether(100), tester2.address);
        await locker.connect(tester3).depositFor(ether(200), tester1.address);

        // 300, 200, 100
      });

      it("check current info", async () => {
        expect(await locker.totalDeposited()).to.equal(ether(600));

        let info;
        info = await locker.userInfo(tester1.address);
        expect(info.amount).to.equal(ether(300));

        info = await locker.userInfo(tester2.address);
        expect(info.amount).to.equal(ether(200));

        info = await locker.userInfo(tester3.address);
        expect(info.amount).to.equal(ether(100));

        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ZERO);
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ZERO);
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ZERO);

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(300));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(200));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(100));
      });
    });

    describe("check claim", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });
      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime - timestamp); //
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(0));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(300));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(200));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(100));
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime + periodicity - timestamp); //
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(25));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(225));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(75));
      });

      it("claim from tester1", async () => {
        const prev = await token.balanceOf(tester1.address);
        await locker.connect(tester1).claim();
        const after = await token.balanceOf(tester1.address);
        expect(after.sub(prev)).equal(ether(75));

        expect((await locker.userInfo(tester1.address)).claimedAmount).to.equal(ether(75));
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(startTime - timestamp + periodicity * 2); // 1/2 passed
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("claim from tester1 and 2", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime + duration - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(100));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(0));
      });

      it("claim all", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
        await locker.connect(tester3).claim();
      });

      it("check", async () => {
        expect(await locker.totalClaimed()).to.equal(ether(600));
        expect(await token.balanceOf(locker.address)).to.equal(ether(0));
      });
    });

    describe("unlock by admin function", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime + periodicity - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(25));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(225));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(75));
      });

      it("suggestUnlock", async () => {
        const prevBal = await ethers.provider.getBalance(feeRecipient.address);
        await locker.suggestUnlock(wei(5000), { value: emergencyUnlockFee });
        const afterBal = await ethers.provider.getBalance(feeRecipient.address);
        expect(afterBal.sub(prevBal)).to.equal(emergencyUnlockFee);
      });

      it("approveSuggestedUnlock", async () => {
        await factory.approveUnlock(locker.address);

        expect(await locker.suggestedUnlockPercent()).to.equal(ZERO);
        expect(await locker.unlockedPercent()).to.equal(wei(5000));
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("claim from tester1", async () => {
        await locker.connect(tester1).claim();
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime + periodicity * 3 - timestamp - 100);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
      });

      it("suggest again", async () => {
        await locker.suggestUnlock(7500, { value: emergencyUnlockFee });
      });

      it("approve again", async () => {
        await factory.approveUnlock(locker.address);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(75));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(75));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(50));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(25));
      });

      it("advance time", async () => {
        timestamp = await getLatestBlockTimestamp();
        await advanceTimeAndBlock(cliffTime + duration - timestamp);
      });

      it("check info", async () => {
        expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
        expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(200));
        expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(100));

        expect(await locker.getVotingPower(tester1.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester2.address)).to.equal(ether(0));
        expect(await locker.getVotingPower(tester3.address)).to.equal(ether(0));
      });

      it("claim all", async () => {
        await locker.connect(tester1).claim();
        await locker.connect(tester2).claim();
        await locker.connect(tester3).claim();
      });

      it("check", async () => {
        expect(await locker.totalClaimed()).to.equal(ether(600));
        expect(await token.balanceOf(locker.address)).to.equal(ether(0));
      });
    });

    describe("unlock by proposal", function () {
      let snapshotID: any;
      before(async () => {
        snapshotID = await getSnapShot();
      });
      after(async () => {
        await revertEvm(snapshotID);
      });

      describe("do initial action", function () {
        it("startProposal", async () => {
          timestamp = await getLatestBlockTimestamp();
          proposalEndTime = timestamp + ONE_DAY_IN_SECONDS.toNumber() + 100;

          await locker.startProposal(5000, proposalEndTime);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          expect(proposal.endTime).to.equal(wei(proposalEndTime));
          expect(proposal.totalPower).to.equal(ether(600));
        });
      });

      describe("Agree vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await locker.connect(tester1).vote(ether(100), true);

          expect(await locker.userVote(1, tester1.address)).to.equal(ether(100));
        });

        it("vote more for success", async () => {
          await locker.connect(tester2).vote(ether(200), true);
          await locker.connect(tester3).vote(ether(50), true);

          await locker.connect(tester3).vote(ether(50), false);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();

          expect(proposal.agree).to.equal(ether(350));
          expect(proposal.disagree).to.equal(ether(50));
        });

        it("endProposal", async () => {
          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(350));
          expect(proposal.disagree).to.equal(ether(50));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(5000));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(cliffTime + periodicity - timestamp);
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("claim some", async () => {
          await locker.connect(tester1).claim();
          await locker.connect(tester2).claim();
          await locker.connect(tester3).claim();
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(startTime - timestamp + periodicity * 2);
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(0));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });

        it("start a new proposal", async () => {
          timestamp = await getLatestBlockTimestamp();
          proposalEndTime = timestamp + ONE_DAY_IN_SECONDS.toNumber() + 100;
          await locker.startProposal(7500, proposalEndTime);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(2));
          expect(proposal.unlockPercent).to.equal(wei(7500));
          expect(proposal.startTime).to.equal(wei(timestamp + 1));
          expect(proposal.endTime).to.equal(wei(proposalEndTime));
          expect(proposal.totalPower).to.equal(ether(300));
        });

        it("vote for success and end", async () => {
          await locker.connect(tester1).vote(ether(100), true);
          await locker.connect(tester2).vote(ether(80), true);
          await locker.connect(tester3).vote(ether(40), true);

          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(1);
          expect(proposal.id).to.equal(wei(2));
          expect(proposal.unlockPercent).to.equal(wei(7500));
          expect(proposal.totalPower).to.equal(ether(300));
          expect(proposal.agree).to.equal(ether(220));
          expect(proposal.disagree).to.equal(ether(0));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(7500));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(75));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(50));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(25));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(75));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(50));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(25));
        });
      });

      describe("Disagree vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await locker.connect(tester1).vote(ether(100), false);
        });

        it("vote more for success", async () => {
          await locker.connect(tester2).vote(ether(200), false);
          await locker.connect(tester3).vote(ether(50), false);
          await locker.connect(tester3).vote(ether(50), true);
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();

          expect(proposal.agree).to.equal(ether(50));
          expect(proposal.disagree).to.equal(ether(350));
        });

        it("endProposal", async () => {
          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(50));
          expect(proposal.disagree).to.equal(ether(350));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(0));
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(0));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(0));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(300));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(200));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(100));
        });
      });

      describe("expire vote", () => {
        let snapshotID: any;
        before(async () => {
          snapshotID = await getSnapShot();
        });
        after(async () => {
          await revertEvm(snapshotID);
        });

        it("vote from tester1", async () => {
          await locker.connect(tester1).vote(ether(100), false);
        });

        it("advance time", async () => {
          await advanceTimeAndBlock(ONE_DAY_IN_SECONDS.toNumber() + 1000);
        });

        it("endProposal", async () => {
          await locker.endProposal();
        });

        it("check proposal info", async () => {
          const proposal = await locker.proposal();
          expect(proposal.id).to.equal(wei(0));
          expect(proposal.unlockPercent).to.equal(wei(0));
          expect(proposal.startTime).to.equal(wei(0));
          expect(proposal.endTime).to.equal(wei(0));
          expect(proposal.totalPower).to.equal(ether(0));
        });

        it("check past proposal", async () => {
          const proposal = await locker.proposals(0);
          expect(proposal.id).to.equal(wei(1));
          expect(proposal.unlockPercent).to.equal(wei(5000));
          timestamp = await getLatestBlockTimestamp();
          expect(proposal.endTime).to.equal(wei(timestamp));
          expect(proposal.totalPower).to.equal(ether(600));
          expect(proposal.agree).to.equal(ether(0));
          expect(proposal.disagree).to.equal(ether(100));
        });

        it("check proposal result", async () => {
          expect(await locker.unlockedPercent()).to.equal(wei(0));
        });

        it("advance time", async () => {
          timestamp = await getLatestBlockTimestamp();
          await advanceTimeAndBlock(cliffTime - timestamp + periodicity * 2); // 1/2 passed
        });

        it("check info", async () => {
          expect(await locker.getClaimableAmount(tester1.address)).to.equal(ether(150));
          expect(await locker.getClaimableAmount(tester2.address)).to.equal(ether(100));
          expect(await locker.getClaimableAmount(tester3.address)).to.equal(ether(50));

          expect(await locker.getVotingPower(tester1.address)).to.equal(ether(150));
          expect(await locker.getVotingPower(tester2.address)).to.equal(ether(100));
          expect(await locker.getVotingPower(tester3.address)).to.equal(ether(50));
        });
      });
    });
  });
});
