/*
  ╔══════════════════════════════════════════════════════════════════════╗
  ║  THE ONLY FILE YOU NEED TO EDIT.                                     ║
  ║  Change the values between the quotes, save, and refresh the page.   ║
  ╚══════════════════════════════════════════════════════════════════════╝
*/
window.INVITE_CONFIG = {

  /* 1. RSVP FORM LINK ------------------------------------------------------
     Paste your Google Forms or Microsoft Forms link between the quotes.
     Until you do, the RSVP seal politely says the form is coming soon.
       Google Forms:     https://forms.gle/xxxxxxxx   (Send > link icon)
       Microsoft Forms:  https://forms.office.com/r/xxxxxxxx   (Share > copy link)  */
  rsvpUrl: "",

  /* Reply-by date shown under the seal. Leave "" to hide the deadline. */
  rsvpBy: "Wednesday, November 11",

  /* 2. THE PARTY ------------------------------------------------------------ */
  title: "Deepawali House Party",

  /* Start and end, as local time at your home: "YYYY-MM-DDTHH:MM:SS".
     Everyone sees the same clock time you type here (their countdown starts from
     that moment in THEIR timezone). If guests live in different timezones, pin
     the time by adding your UTC offset, e.g. "2026-11-14T16:30:00-08:00" for PST.
     Leave end as "" if there is no fixed end. */
  start: "2026-11-14T16:30:00",
  end:   "",

  /* 3. THE PLACE ------------------------------------------------------------ */
  venueName: "Our home",

  /* Full street address. When filled in, a "Get directions" link appears and the
     address goes into guests' calendar events. Leave "" to hide both. */
  venueAddress: "",

  /* 4. THE HOSTS ------------------------------------------------------------
     Names for the sign-off at the bottom, e.g. "Asha and Ravi". Leave "" to hide. */
  hosts: "",

  /* 5. FINE PRINT ----------------------------------------------------------- */
  locale: "en-US",   /* how dates are written: "en-US" = November 14, "en-GB"/"en-IN" = 14 November */
  calendarNote: "Wear your festive best. Diyas, music and good food await."
};

/* TIP: personalise the greeting per guest by sharing the link with their name on the end:
     https://your-site.example/?to=The%20Patel%20Family   ->  "Dear The Patel Family,"        */
