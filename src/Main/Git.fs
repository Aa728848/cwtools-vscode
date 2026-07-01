module Main.Git

open LibGit2Sharp
open System
open System.IO
open System.Linq
open CWTools.Utilities.Utils

let rec initOrUpdateRules repoPath gameCacheDir stable first =
    if Directory.Exists gameCacheDir then
        ()
    else
        Directory.CreateDirectory gameCacheDir |> ignore

    try
        let mutable isRepo = Repository.IsValid gameCacheDir

        let shouldReplaceCache =
            if isRepo then
                use existingGit = new Repository(gameCacheDir)
                match existingGit.Network.Remotes["origin"] with
                | null -> false
                | existingRemote ->
                    not (String.Equals(existingRemote.Url, repoPath, StringComparison.OrdinalIgnoreCase))
            else
                false

        if shouldReplaceCache then
            logInfo $"cwtools rules remote changed; rebuilding rules cache from %s{repoPath}"
            Directory.Delete(gameCacheDir, true)
            Directory.CreateDirectory(gameCacheDir) |> ignore
            isRepo <- false

        if isRepo then
            ()
        else
            Repository.Clone(repoPath, gameCacheDir) |> ignore

        let git = new Repository(gameCacheDir)
        let remote =
            match git.Network.Remotes["origin"] with
            | null -> git.Network.Remotes.Add("origin", repoPath)
            | existingRemote -> existingRemote
        let refSpecs = remote.FetchRefSpecs.Select(fun x -> x.Specification)
        Commands.Fetch(git, remote.Name, refSpecs, null, "")
        let currentHash = git.Head.Tip.Sha
        logInfo $"cwtools current rules version: %A{currentHash}"

        let remoteBranch =
            [ "origin/master"; "origin/main" ]
            |> Seq.tryPick (fun branchName ->
                match git.Branches[branchName] with
                | null -> None
                | branch -> Some branch)
            |> Option.defaultWith (fun () ->
                failwith "Could not find a fetched origin/master or origin/main branch for CWTools rules.")

        match stable with
        | true ->
            let describeOptions = DescribeOptions()
            describeOptions.Strategy <- DescribeStrategy.Tags
            describeOptions.MinimumCommitIdAbbreviatedSize <- 0
            let tag = git.Describe(remoteBranch.Tip, describeOptions)
            let checkoutOptions = CheckoutOptions()
            checkoutOptions.CheckoutModifiers <- CheckoutModifiers.Force
            Commands.Checkout(git, tag, checkoutOptions) |> ignore
        | false -> git.Reset(ResetMode.Hard, remoteBranch.Tip)

        let newHash = git.Head.Tip.Sha
        logInfo $"cwtools new rules version: %A{newHash}"
        (newHash <> currentHash) || not isRepo, Some git.Head.Tip.Committer.When
    with ex ->
        logError $"cwtools git error, recovering, error: %A{ex}"
        try
            use git = new Repository(gameCacheDir)
            git.Reset(ResetMode.Hard, git.Branches["origin/master"].Tip)
        with innerEx ->
            logError $"cwtools git recovery failed: %A{innerEx}"


        if first then
            initOrUpdateRules repoPath gameCacheDir stable false
        else
            (false, None)


// var initOrUpdateRules = function(folder : string, repoPath : string, logger : vs.OutputChannel, first? : boolean) {
//  const gameCacheDir = isDevDir ? context.storagePath + '/.cwtools/' + folder : context.extensionPath + '/.cwtools/' + folder
//  var rulesVersion = "embedded"
//  if (rulesChannel != "none") {
//   !isDevDir || fs.existsSync(context.storagePath) || fs.mkdirSync(context.storagePath)
//   fs.existsSync(cacheDir) || fs.mkdirSync(cacheDir)
//   fs.existsSync(gameCacheDir) || fs.mkdirSync(gameCacheDir)
//   const git = simplegit(gameCacheDir)
//   let ret = git.checkIsRepo()
//    .then(isRepo => !isRepo && git.clone(repoPath, gameCacheDir))
//    .then(() => git.fetch())
//    .then(() => git.log())
//    .then((log) => { logger.appendLine("cwtools current rules version: " + log.latest.hash); return log.latest.hash })
//    .then((prevHash : string) => { return Promise.all([prevHash, git.checkout("master")]) })
//    //@ts-ignore
//    .then(function ([prevHash, _]) { return Promise.all([prevHash, rulesChannel == "latest" ? git.reset(["--hard", "origin/master"]) : git.checkoutLatestTag()])} )
//    .then(function ([prevHash, _]) { return Promise.all([prevHash, git.log()]) })
//    .then(function ([prevHash, log]) { return log.latest.hash == prevHash ? undefined : log.latest.date })
//    .catch(() => { logger.appendLine("cwtools git error, recovering"); git.reset(["--hard", "origin/master"]); first && initOrUpdateRules(folder, repoPath, logger, false) })
//   return ret;
//   }
//  else {
//   return Promise.resolve()
//  }
// }
