// Version history shown in the app ("What's new"), newest first.
// The first entry is the current version. Add an entry with every release:
//   patch (1.2.3 -> 1.2.4)  fixes and small tweaks
//   minor (1.2.3 -> 1.3.0)  new features
//   major (1.2.3 -> 2.0.0)  big changes to how the app works
// Write the changes for the people using the app, not for programmers.

export const CHANGELOG = [
  {
    version: '1.7.0',
    date: '2026-09-30',
    changes: [
      'Track how long each frame takes to build. Mark the frames you’re working on as Building, then press Start timer in the Painting section. The running timer shows at the top, with a Stop button.',
      'When you’re building several frames at once, the time is split equally between them. If one starts or finishes partway through, the split changes from that moment. The timer stops by itself when nothing is being built.',
      'Each frame shows its total time and a time log. Add time the timer missed by hand (or take some off), and remove entries you don’t want.',
      'The Library has a Time column with each frame’s total.',
    ],
  },
  {
    version: '1.6.2',
    date: '2026-09-30',
    changes: [
      'On a phone, the buttons at the top now all fit on screen: the search box, the status and the buttons each get their own row. The top bar also scrolls away with the page, leaving more room for the painting.',
    ],
  },
  {
    version: '1.6.1',
    date: '2026-09-30',
    changes: [
      'Cutting setup and SKU numbering have moved into Settings (the ⚙ button at the top right), leaving more room for the painting. The ⚙ button shows a dot when something in there hasn’t been saved.',
      'The buttons at the top are now in the order Share, New, Save, Save as new.',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-09-30',
    changes: [
      'Frames now have a status: Not started, 🔨 Building or ✓ Made. Set it with the three buttons at the top of the Painting section; it’s saved straight away with the date.',
      'A frame that’s being built shows an amber badge, like the green one for made frames, and you’re warned if you start changing it.',
      'The list for loading a saved painting shows each frame’s status with an icon (○ not started, 🔨 building, ✅ made).',
      'The Library has a Status column and can show only the frames not started, being built, made, or not made yet.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-09-29',
    changes: [
      'Mark a frame as made with the new button at the top of the Painting section. A made frame shows a green “Made” badge with the date, and you’re warned if you start changing it.',
      'The Library has a Made column, and you can show all paintings, only those not made yet, or only the made ones.',
      'New Share button: makes a read-only link to one frame that anyone can open without signing in. They see the cut list, 3D model and drawing, and can try other frame settings without saving anything. Stop sharing turns the link off.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-09-29',
    changes: [
      'Changes you haven’t saved yet are highlighted, so you can see exactly what Save will change. The status at the top shows how many there are.',
      'Hover over a changed value to get a ↺ button: its tooltip shows the saved value, and clicking it puts back just that one value.',
      'New Reload button (shown when there are unsaved changes) discards all of them and reloads the saved version, after asking first.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-09-29',
    changes: [
      'New Generate button beside the SKU: fills in the next SKU, e.g. FF-2026-0042. The number carries on from your saved paintings and starts again at 0001 each year.',
      'New SKU numbering section to set the format and prefix, with a preview of the next SKU. It’s saved automatically as your default.',
      'A guided tour shows new users around the app. Run it again any time from Tour under the title.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-09-29',
    changes: [
      'New "Save as new" button: load a saved painting, change the SKU (and anything else), and save it as a separate painting. The original stays as it was, and the copy gets its own copy of the painting image. Shortcut: Ctrl+Shift+S.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-09-29',
    changes: [
      'The version number is now shown under the title. Click it to see what changed in each version.',
      'Admins (the first account on the site) can see the sign-up invite code in the app: Invite code at the top right. From there you can copy an invite message, make a new code, or turn sign-up off and on.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-29',
    changes: [
      'Online accounts: sign in to your own private library of paintings and default settings.',
      'New people can create an account with an invite code.',
      'Change password and Sign out at the top right.',
      'You stay signed in for a year from your last visit, including after restarting your computer.',
      'The app can be hosted at its own web address (e.g. under /framingapp/).',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-09-28',
    changes: [
      'Click a row in the Corners & tape shims table to show that corner\'s tape setup in the sled diagram, including the number of tape layers.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-28',
    changes: [
      'Technical drawing: the front view shows both corner-to-corner diagonals.',
      'Technical drawing: the short point length on each strip is shown faintly, so the long point stands out.',
      'New good wood choices for the 3D model: Jarrah, Blue Gum and Messmate.',
    ],
  },
  {
    version: '0.3.1',
    date: '2026-09-28',
    changes: [
      'Australian English spelling throughout ("mitre").',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-28',
    changes: [
      'Cut list is ordered Top, Bottom, Left, Right, and identical opposite strips share one row (e.g. "Top & Bottom ×2").',
      'New table of the assembled frame\'s diagonals, to check the glue-up is square.',
      'The small painting sketch beside the size inputs is drawn to the proportions you enter.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-28',
    changes: [
      'Phones, tablets and other computers on your home network can open the app.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-28',
    changes: [
      'First version: cut list for all 8 strips, corner and mitre angles, masking-tape shims for the 45° sled, 3D model and technical drawing.',
      'Library of saved paintings, with remembered artists and default frame settings.',
    ],
  },
];

export const VERSION = CHANGELOG[0].version;
