import * as core from "@actions/core";

export { Runner };

class Runner {
  constructor(pullRequest, privilegedRequesters) {
    this.pullRequest = pullRequest;
    this.privilegedRequesters = privilegedRequesters;
  }

  async processCommits(privileged_requester_username) {
    // Check all commits of the PR to verify that they are all from the privileged requester, otherwise return from the check
    core.info(
      `Commits: Comparing the PR commits to verify that they are all from ${privileged_requester_username}`,
    );

    const useCommitVerification = core.getBooleanInput("commitVerification");
    let allCommitsVerified = true;

    const commits = Object.entries(await this.pullRequest.listCommits());

    core.debug(`checking commits: ${commits.length}`);

    for (const [, commit] of commits) {
      var commitAuthor = null;
      try {
        commitAuthor = commit.author.login.toLowerCase();
      } catch (e) {
        if (core.getBooleanInput("fallback_to_commit_author") === true) {
          core.debug(`commit.author.login not found: ${e}`);
          core.debug(
            `trying commit.commit.author.name: ${commit.commit.author.name}`,
          );
          commitAuthor = commit.commit.author.name.toLowerCase();
        } else {
          throw new Error(`commit.author.login not found: ${e}`);
        }
      }

      const commitVerification = commit?.commit?.verification?.verified;
      const sha = commit?.sha;

      core.debug(`checking commit: ${sha}`);

      // check if the commit is verified
      if (!commitVerification) {
        allCommitsVerified = false;
        if (useCommitVerification === true) {
          core.warning(`Unexpected unverified commit - sha: ${sha}`);
          core.warning(`commit.verification.verified: ${commitVerification}`);

          core.debug(`commit: ${JSON.stringify(commit, null, 2)}`);

          // if we are using commit verification and the commit is not signed, return false
          return false;
        }
      }

      if (commitAuthor !== privileged_requester_username) {
        core.warning(
          `Unexpected commit author found by ${commitAuthor}! Commits should be authored by ${privileged_requester_username}. I will not proceed with the privileged reviewer process - sha: ${sha}`,
        );
        return false;
      }
    }

    core.info(
      `Commits: All commits are made by ${privileged_requester_username}. Success!`,
    );

    core.setOutput("commits_verified", allCommitsVerified);

    if (allCommitsVerified === true) {
      core.info("Commits: All commits are verified. Success!");
    }

    // if we make it this far, we have verified that all commits are from the privileged requester
    return true;
  }

  async processDiff() {
    core.info(
      `Diff: Checking the access diff to verify that there are only removals`,
    );
    let diff = await this.pullRequest.getDiff();
    let diffArray = diff.split("\n");
    for (const [, diffLine] of Object.entries(diffArray)) {
      // Check each line to make sure it doesn't add access
      if (diffLine.startsWith("+++")) {
        continue;
      }
      if (diffLine.startsWith("+")) {
        core.warning(
          `Diff: This PR includes additions which are not allowed with the checkDiff option`,
        );
        return false;
      }
    }
    core.info(`Diff: This PR only includes removals. Success!`);
    return true;
  }

  labelsEqual(prLabels, configuredLabels) {
    if (prLabels.length !== configuredLabels.length) {
      return false;
    }

    const prLabelSet = new Set(prLabels);
    const configuredLabelsSet = new Set(configuredLabels);

    for (const label of prLabelSet) {
      if (!configuredLabelsSet.has(label)) {
        return false;
      }
    }

    return true;
  }

  async processLabels(privileged_requester_config) {
    // Check labels of the PR to make sure that they match the privileged_requester_config, otherwise return from the check
    const prLabels = await this.pullRequest.listLabels();
    const prLabelArray = [];

    for (const [, prLabel] of Object.entries(prLabels)) {
      let prLabelName = prLabel.name;
      prLabelArray.push(prLabelName);
    }

    core.info(
      `Labels: Comparing the PR Labels: ${prLabelArray} with the privileged requester labels: ${privileged_requester_config.labels}`,
    );
    if (
      this.labelsEqual(prLabelArray, privileged_requester_config.labels) ===
      false
    ) {
      core.warning(
        `Labels: Invalid label(s) found. I will not proceed with the privileged reviewer process.`,
      );
      return false;
    }
    core.info(
      `Labels: Labels on the PR match those in the privileged reviewer config. Success!`,
    );
    return true;
  }

  async run() {
    let approved = false; // a variable to track whether the PR has been approved
    const requesters = await this.privilegedRequesters.getRequesters();
    if (requesters === false) {
      return;
    }
    for (const [
      privileged_requester_username,
      privileged_requester_config,
    ] of Object.entries(requesters)) {
      // console.log(privileged_requester_username);
      // If privileged_requester_username is not the creator of the PR, move on
      // If privileged_requester_username is the creator of the PR, check the remaining config
      core.info(
        `PR creator is ${this.pullRequest.prCreator}. Testing against ${privileged_requester_username}`,
      );
      if (this.pullRequest.prCreator !== privileged_requester_username) {
        continue;
      }
      let result = await this.processPrivilegedReviewer(
        privileged_requester_username,
        privileged_requester_config,
      );

      if (result === true) {
        approved = true;
        core.info(
          `Privileged requester ${privileged_requester_username} checks passed.`,
        );
      }
    }

    if (approved === true) {
      core.info(`✅ Approved!`);
    } else {
      core.info(
        `🙅 No privileged requester found. This pull request will not be approved by this Action`,
      );
    }
  }

  async processPrivilegedReviewer(
    privileged_requester_username,
    privileged_requester_config,
  ) {
    core.info(
      `Privileged requester ${privileged_requester_username} found. Checking PR criteria against the privileged requester configuration.`,
    );

    this.checkCommits = core.getInput("checkCommits");
    if (this.checkCommits === "true") {
      let commits = await this.processCommits(privileged_requester_username);
      if (commits === false) {
        return false;
      }
    }

    this.checkDiff = core.getInput("checkDiff");
    if (this.checkDiff === "true") {
      let diff = await this.processDiff();
      if (diff === false) {
        return false;
      }
    }

    this.checkLabels = core.getInput("checkLabels");
    if (this.checkLabels === "true") {
      let labels = await this.processLabels(privileged_requester_config);
      if (labels === false) {
        return false;
      }
    }

    // If we've gotten this far, the commits are all from the privileged requester and the labels are correct
    // We can now approve the PR
    await this.pullRequest.approve();
    return true;
  }
}
